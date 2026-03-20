/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

const CODEX_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const DEFAULT_RESTART_SCRIPT_PATH = path.resolve(process.cwd(), 'restart-bridge.bat');

interface ModelCommandArgs {
  model: string;
  reasoningEffort: string;
}

interface FeishuFileCapableAdapter {
  sendFileBrowserCard(
    chatId: string,
    currentPath: string,
    entries: Array<{ label: string; actionLabel: 'Open' | 'Send'; callbackData: string }>,
    notice?: string,
  ): Promise<SendResult>;
  sendLocalFile(chatId: string, absolutePath: string): Promise<SendResult>;
}

interface ParsedFileCommandArgs {
  mode: 'browse' | 'send';
  requestedPath: string;
  error?: string;
}

const FILE_BROWSER_MAX_ITEMS = 40;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseModelCommandArgs(raw: string): ModelCommandArgs | null {
  const parts = raw.split(/\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const [model, reasoningEffortRaw] = parts;
  const reasoningEffort = reasoningEffortRaw.toLowerCase();
  if (!CODEX_REASONING_EFFORTS.has(reasoningEffort)) return null;
  return { model, reasoningEffort };
}

function getConfiguredRuntime(): string {
  const { store } = getBridgeContext();
  return (store.getSetting('bridge_runtime') || process.env.CTI_RUNTIME || 'claude').toLowerCase();
}

function upsertTomlString(content: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const trimmed = content.trimEnd();
  return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

export function writeCodexDefaultModelConfig(
  model: string,
  reasoningEffort: string,
  configPath = DEFAULT_CODEX_CONFIG_PATH,
): void {
  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // Create a new config file when none exists yet.
  }

  let updated = upsertTomlString(content, 'model', model);
  updated = upsertTomlString(updated, 'model_reasoning_effort', reasoningEffort);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, updated, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

export function triggerBridgeRestart(scriptPath = DEFAULT_RESTART_SCRIPT_PATH): void {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Restart script not found: ${scriptPath}`);
  }
  const child = spawn('cmd.exe', ['/c', scriptPath], {
    cwd: path.dirname(scriptPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

function isFeishuFileCapableAdapter(adapter: BaseChannelAdapter): adapter is BaseChannelAdapter & FeishuFileCapableAdapter {
  const candidate = adapter as Partial<FeishuFileCapableAdapter> & { channelType?: string };
  return candidate.channelType === 'feishu'
    && typeof candidate.sendFileBrowserCard === 'function'
    && typeof candidate.sendLocalFile === 'function';
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toDisplayRelativePath(rootDir: string, targetPath: string): string {
  const relative = path.relative(rootDir, targetPath);
  if (!relative) return '.';
  return relative.split(path.sep).join('/');
}

function encodeFileBrowserPath(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

function decodeFileBrowserPath(encoded: string): string | null {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function escapeFileLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

function parseFileCommandArgs(raw: string): ParsedFileCommandArgs {
  if (!raw) {
    return { mode: 'browse', requestedPath: '' };
  }

  const sendMatch = raw.match(/^--send-b64\s+(\S+)$/);
  if (sendMatch) {
    const decoded = decodeFileBrowserPath(sendMatch[1]);
    return decoded == null
      ? { mode: 'send', requestedPath: '', error: 'Invalid file action payload.' }
      : { mode: 'send', requestedPath: decoded };
  }

  const openMatch = raw.match(/^--open-b64\s+(\S+)$/);
  if (openMatch) {
    const decoded = decodeFileBrowserPath(openMatch[1]);
    return decoded == null
      ? { mode: 'browse', requestedPath: '', error: 'Invalid file action payload.' }
      : { mode: 'browse', requestedPath: decoded };
  }

  return { mode: 'browse', requestedPath: raw.trim() };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit) ─────────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (result.responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let postResponseAction: (() => void) | null = null;

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/model &lt;model&gt; &lt;effort&gt; - Set model for this session',
        '/default-model &lt;model&gt; &lt;effort&gt; - Set global Codex default model',
        '/restart - Restart the bridge daemon',
        '/status - Show current status',
        '/whoami - Show your user/chat IDs',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/file [path] - Browse or send files from the current working directory (Feishu only)',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const parsed = parseModelCommandArgs(args);
      if (!parsed) {
        response = 'Usage: /model &lt;model&gt; &lt;minimal|low|medium|high|xhigh&gt;';
        break;
      }
      const binding = router.resolve(msg.address);
      store.updateSessionTurnConfig(binding.codepilotSessionId, {
        model: parsed.model,
        reasoning_effort: parsed.reasoningEffort,
        model_override: true,
      });
      store.updateSdkSessionId(binding.codepilotSessionId, '');
      router.updateBinding(binding.id, {
        model: parsed.model,
        reasoningEffort: parsed.reasoningEffort,
        modelOverride: true,
      });
      const runtime = getConfiguredRuntime();
      response = [
        'Session model updated.',
        `Model: <code>${escapeHtml(parsed.model)}</code>`,
        `Reasoning: <code>${escapeHtml(parsed.reasoningEffort)}</code>`,
        runtime === 'codex'
          ? 'Codex runtime will use this override on the next turn.'
          : `Current runtime is <code>${escapeHtml(runtime)}</code>; reasoning effort only applies on Codex.`,
      ].join('\n');
      break;
    }

    case '/default-model': {
      const parsed = parseModelCommandArgs(args);
      if (!parsed) {
        response = 'Usage: /default-model &lt;model&gt; &lt;minimal|low|medium|high|xhigh&gt;';
        break;
      }
      const runtime = getConfiguredRuntime();
      if (runtime !== 'codex') {
        response = `Current runtime is <code>${escapeHtml(runtime)}</code>; skipped updating Codex global config.`;
        break;
      }
      try {
        writeCodexDefaultModelConfig(parsed.model, parsed.reasoningEffort);
        response = [
          'Updated Codex global defaults.',
          `Model: <code>${escapeHtml(parsed.model)}</code>`,
          `Reasoning: <code>${escapeHtml(parsed.reasoningEffort)}</code>`,
        ].join('\n');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = `Failed to update Codex config: <code>${escapeHtml(message)}</code>`;
      }
      break;
    }

    case '/restart': {
      try {
        if (!fs.existsSync(DEFAULT_RESTART_SCRIPT_PATH)) {
          throw new Error(`Restart script not found: ${DEFAULT_RESTART_SCRIPT_PATH}`);
        }
        postResponseAction = () => {
          try {
            triggerBridgeRestart();
          } catch (error) {
            console.error('[bridge-manager] Failed to trigger restart:', error);
          }
        };
        response = 'Restart requested. Restart script is launching...';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = `Failed to launch restart script: <code>${escapeHtml(message)}</code>`;
      }
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const session = store.getSession(binding.codepilotSessionId);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Reasoning: <code>${binding.reasoningEffort || session?.reasoning_effort || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/whoami': {
      response = [
        '<b>Identity</b>',
        '',
        `Channel: <code>${escapeHtml(msg.address.channelType)}</code>`,
        `User ID: <code>${escapeHtml(msg.address.userId || 'unavailable')}</code>`,
        `Chat ID: <code>${escapeHtml(msg.address.chatId)}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/file': {
      if (!isFeishuFileCapableAdapter(adapter)) {
        response = 'The /file command is currently available on Feishu only.';
        break;
      }

      const binding = router.resolve(msg.address);
      const rootDir = (binding.workingDirectory || '').trim();
      if (!rootDir || !path.isAbsolute(rootDir)) {
        response = 'Working directory is not configured to an absolute path.';
        break;
      }

      const resolvedRootDir = path.resolve(rootDir);
      if (!fs.existsSync(resolvedRootDir)) {
        response = `Working directory not found: <code>${escapeHtml(resolvedRootDir)}</code>`;
        break;
      }

      let rootStat: fs.Stats;
      try {
        rootStat = fs.statSync(resolvedRootDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = `Failed to read working directory: <code>${escapeHtml(message)}</code>`;
        break;
      }
      if (!rootStat.isDirectory()) {
        response = `Working directory is not a directory: <code>${escapeHtml(resolvedRootDir)}</code>`;
        break;
      }

      const parsed = parseFileCommandArgs(args);
      if (parsed.error) {
        response = parsed.error;
        break;
      }

      const targetPath = parsed.requestedPath
        ? path.resolve(resolvedRootDir, parsed.requestedPath)
        : resolvedRootDir;
      if (!isWithinDirectory(resolvedRootDir, targetPath)) {
        response = 'Path must stay within the current working directory.';
        break;
      }
      if (!fs.existsSync(targetPath)) {
        response = `Path not found: <code>${escapeHtml(toDisplayRelativePath(resolvedRootDir, targetPath))}</code>`;
        break;
      }

      let targetStat: fs.Stats;
      try {
        targetStat = fs.statSync(targetPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = `Failed to inspect path: <code>${escapeHtml(message)}</code>`;
        break;
      }

      if (parsed.mode === 'send' || targetStat.isFile()) {
        if (!targetStat.isFile()) {
          response = 'Cannot send a directory. Use /file <folder> to open it.';
          break;
        }
        const sendResult = await adapter.sendLocalFile(msg.address.chatId, targetPath);
        if (!sendResult.ok) {
          response = `Failed to send file: <code>${escapeHtml(sendResult.error || 'unknown error')}</code>`;
        }
        break;
      }

      if (!targetStat.isDirectory()) {
        response = 'Unsupported path type.';
        break;
      }

      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(targetPath, { withFileTypes: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = `Failed to read directory: <code>${escapeHtml(message)}</code>`;
        break;
      }

      const sortedEntries = dirEntries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .sort((left, right) => {
          const leftRank = left.isDirectory() ? 0 : 1;
          const rightRank = right.isDirectory() ? 0 : 1;
          if (leftRank !== rightRank) return leftRank - rightRank;
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        });

      const cardEntries: Array<{ label: string; actionLabel: 'Open' | 'Send'; callbackData: string }> = [];
      if (targetPath !== resolvedRootDir) {
        const parentPath = path.dirname(targetPath);
        const parentRelative = toDisplayRelativePath(resolvedRootDir, parentPath) === '.'
          ? ''
          : path.relative(resolvedRootDir, parentPath);
        cardEntries.push({
          label: '📁 `..`',
          actionLabel: 'Open',
          callbackData: parentRelative ? `file:open:${encodeFileBrowserPath(parentRelative)}` : 'file:open',
        });
      }

      const visibleEntries = sortedEntries.slice(0, FILE_BROWSER_MAX_ITEMS);
      for (const entry of visibleEntries) {
        const absoluteEntryPath = path.join(targetPath, entry.name);
        const relativeEntryPath = path.relative(resolvedRootDir, absoluteEntryPath);
        cardEntries.push({
          label: `${entry.isDirectory() ? '📁' : '📄'} ${escapeFileLabel(entry.name)}`,
          actionLabel: entry.isDirectory() ? 'Open' : 'Send',
          callbackData: `file:${entry.isDirectory() ? 'open' : 'send'}:${encodeFileBrowserPath(relativeEntryPath)}`,
        });
      }

      const truncatedCount = sortedEntries.length - visibleEntries.length;
      const notice = truncatedCount > 0
        ? `Showing first ${visibleEntries.length} items. ${truncatedCount} more item(s) are hidden.`
        : undefined;
      const browseResult = await adapter.sendFileBrowserCard(
        msg.address.chatId,
        toDisplayRelativePath(resolvedRootDir, targetPath),
        cardEntries,
        notice,
      );
      if (!browseResult.ok) {
        response = `Failed to send file browser: <code>${escapeHtml(browseResult.error || 'unknown error')}</code>`;
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/model &lt;model&gt; &lt;effort&gt; - Set model for this session',
        '/default-model &lt;model&gt; &lt;effort&gt; - Set global Codex default model',
        '/restart - Restart the bridge daemon',
        '/status - Show current status',
        '/whoami - Show your user/chat IDs',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/file [path] - Browse or send files from the current working directory (Feishu only)',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
  if (postResponseAction) {
    setTimeout(postResponseAction, 0);
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
