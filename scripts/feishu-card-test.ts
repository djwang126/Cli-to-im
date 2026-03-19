import fs from 'node:fs';
import path from 'node:path';

import * as lark from '@larksuiteoapi/node-sdk';

import { CTI_HOME, loadConfig } from '../src/config.ts';
import {
  FEISHU_STREAMING_ELEMENT_ID,
  buildCardCreateData,
  buildCardReferenceContent,
  buildCardSettingsData,
  buildCardUpdateData,
  resolveFeishuDomain,
} from '../packages/claude-to-im/src/lib/bridge/adapters/feishu-cardkit.ts';
import {
  buildCardContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  buildStreamingContent,
  buildStreamingCardJson,
  FEISHU_THINKING_MARKER,
  formatElapsed,
  type FeishuFinalCardEntry,
} from '../packages/claude-to-im/src/lib/bridge/markdown/feishu.ts';
import type { ToolCallInfo } from '../packages/claude-to-im/src/lib/bridge/types.ts';

type Mode = 'static' | 'stream' | 'permission' | 'all';

interface FeishuBinding {
  channelType: string;
  chatId: string;
  active?: boolean;
  updatedAt?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTextEntry(entries: FeishuFinalCardEntry[], delta: string): void {
  if (!delta) return;

  const last = entries[entries.length - 1];
  if (last?.kind === 'text') {
    last.content += delta;
    return;
  }

  const normalized = entries.length > 0 ? delta.replace(/^\n+/, '') : delta;
  if (!normalized) return;
  if (!normalized.trim() && entries.length > 0) return;
  entries.push({ kind: 'text', content: normalized });
}

function appendToolsEntry(entries: FeishuFinalCardEntry[]): void {
  const last = entries[entries.length - 1];
  if (last?.kind === 'tools') return;
  entries.push({ kind: 'tools', content: FEISHU_THINKING_MARKER });
}

function appendRenderedText(entries: FeishuFinalCardEntry[], previous: string, current: string): string {
  let delta = current;
  if (previous && current.startsWith(previous)) {
    delta = current.slice(previous.length);
  } else if (previous === current) {
    delta = '';
  }
  appendTextEntry(entries, delta);
  return current;
}

function hasToolPhaseChange(previousTools: ToolCallInfo[], nextTools: ToolCallInfo[]): boolean {
  const previousStatuses = new Map(previousTools.map((tool) => [tool.id, tool.status]));
  for (const tool of nextTools) {
    if (previousStatuses.get(tool.id) !== tool.status) return true;
  }
  return false;
}

function cloneTranscript(entries: FeishuFinalCardEntry[]): FeishuFinalCardEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function buildCommittedTranscript(
  transcript: FeishuFinalCardEntry[],
  previousText: string,
  renderedText: string,
  toolPhasePending: boolean,
  toolPhaseTextCheckpoint: string,
): FeishuFinalCardEntry[] {
  const next = cloneTranscript(transcript);
  if (!toolPhasePending) {
    appendRenderedText(next, previousText, renderedText);
    return next;
  }

  appendRenderedText(next, previousText, toolPhaseTextCheckpoint);
  if (renderedText !== toolPhaseTextCheckpoint) {
    appendRenderedText(next, toolPhaseTextCheckpoint, renderedText);
  }
  return next;
}

function buildPreviewTranscript(
  committedTranscript: FeishuFinalCardEntry[],
  toolPhaseWaitingForText: boolean,
): FeishuFinalCardEntry[] {
  if (!toolPhaseWaitingForText) return committedTranscript;
  const preview = cloneTranscript(committedTranscript);
  appendToolsEntry(preview);
  return preview;
}

function parseArgs(argv: string[]): { mode: Mode; chatId?: string } {
  let mode: Mode = 'all';
  let chatId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      mode = argv[i + 1] as Mode;
      i++;
      continue;
    }
    if (arg === '--chat-id' && argv[i + 1]) {
      chatId = argv[i + 1];
      i++;
    }
  }

  return { mode, chatId };
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function resolveTargetChatId(explicitChatId?: string): string {
  if (explicitChatId) return explicitChatId;

  const bindingsPath = path.join(CTI_HOME, 'data', 'bindings.json');
  const bindings = readJson<Record<string, FeishuBinding>>(bindingsPath, {});
  const latest = Object.values(bindings)
    .filter((binding) => binding.channelType === 'feishu' && binding.active !== false)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];

  if (!latest?.chatId) {
    throw new Error(`No active Feishu binding found in ${bindingsPath}`);
  }

  return latest.chatId;
}

function warnIfDaemonStopped(): void {
  const statusPath = path.join(CTI_HOME, 'runtime', 'status.json');
  const status = readJson<{ running?: boolean }>(statusPath, {});
  if (!status.running) {
    console.warn('[feishu:card:test] Bridge daemon does not appear to be running; permission-card callbacks will not be consumed until it is started.');
  }
}

async function createClient() {
  const config = loadConfig();
  if (!config.feishuAppId || !config.feishuAppSecret) {
    throw new Error('CTI_FEISHU_APP_ID / CTI_FEISHU_APP_SECRET are not configured');
  }

  const domain = resolveFeishuDomain(config.feishuDomain);
  const client = new lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    domain: domain.sdkDomain,
  });

  return { client, domain };
}

async function sendStaticCard(client: lark.Client, chatId: string): Promise<void> {
  const content = buildCardContent([
    '## Feishu Static Card Test',
    '',
    '```ts',
    "console.log('hello from card test')",
    '```',
    '',
    '| stage | status |',
    '| --- | --- |',
    '| static | ok |',
  ].join('\n'));

  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content,
    },
  });

  console.log('[feishu:card:test] static card sent:', res?.data?.message_id || 'unknown');
}

async function sendStreamingCard(client: lark.Client, chatId: string): Promise<void> {
  const createResp = await client.cardkit.v1.card.create({
    data: buildCardCreateData(buildStreamingCardJson()),
  });
  const cardId = createResp?.data?.card_id;
  if (!cardId) {
    throw new Error('CardKit create returned no card_id');
  }

  const sendResp = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: buildCardReferenceContent(cardId),
    },
  });

  console.log('[feishu:card:test] streaming card sent:', {
    cardId,
    messageId: sendResp?.data?.message_id || 'unknown',
  });

  const toolSets: ToolCallInfo[][] = [
    [{ id: 'tool-1', name: 'workspace.scan', status: 'running' as const }],
    [
      { id: 'tool-1', name: 'workspace.scan', status: 'complete' as const },
      { id: 'tool-2', name: 'cardkit.update', status: 'running' as const },
    ],
    [
      { id: 'tool-1', name: 'workspace.scan', status: 'complete' as const },
      { id: 'tool-2', name: 'cardkit.update', status: 'complete' as const },
    ],
  ];
  const texts = [
    '第一段：流式卡片诊断启动中。',
    '第二段：继续追加内容，并模拟工具状态变化。',
    '第三段：准备收尾并关闭流式模式。',
  ];

  let sequence = 0;
  const startedAt = Date.now();
  const transcript: FeishuFinalCardEntry[] = [];
  let renderedText = '';
  let lastTools: ToolCallInfo[] = [];
  let toolPhasePending = false;
  let toolPhaseTextCheckpoint = '';

  for (let i = 0; i < texts.length; i++) {
    if (toolSets[i].length > 0 && hasToolPhaseChange(lastTools, toolSets[i])) {
      toolPhasePending = true;
      toolPhaseTextCheckpoint = renderedText;
    }
    const nextRenderedText = texts.slice(0, i + 1).join('\n\n');
    const committedTranscript = buildCommittedTranscript(
      transcript,
      renderedText,
      nextRenderedText,
      toolPhasePending,
      toolPhaseTextCheckpoint,
    );
    const toolPhaseWaitingForText = toolPhasePending && nextRenderedText === toolPhaseTextCheckpoint;
    const previewTranscript = buildPreviewTranscript(committedTranscript, toolPhaseWaitingForText);
    renderedText = nextRenderedText;
    lastTools = toolSets[i].map((tool) => ({ ...tool }));
    sequence++;
    await client.cardkit.v1.cardElement.content({
      path: {
        card_id: cardId,
        element_id: FEISHU_STREAMING_ELEMENT_ID,
      },
      data: {
        content: buildStreamingContent(previewTranscript, renderedText, lastTools),
        sequence,
      },
    });
    transcript.splice(0, transcript.length, ...committedTranscript);
    if (!toolPhaseWaitingForText) {
      toolPhasePending = false;
      toolPhaseTextCheckpoint = '';
    }
    console.log('[feishu:card:test] streaming update ok:', { cardId, sequence });
    await sleep(700);
  }

  sequence++;
  await client.cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: buildCardSettingsData({
      streaming_mode: false,
      summary: { content: '诊断流式卡片已完成' },
    }, sequence),
  });
  console.log('[feishu:card:test] streaming mode closed:', { cardId, sequence });

  if (!toolPhasePending) {
    console.log('[feishu:card:test] final card refresh skipped:', { cardId, reason: 'content already matches final stream' });
    return;
  }

  sequence++;
  const finalCardJson = buildFinalCardJson(
    renderedText,
    lastTools,
    {
      status: '✅ Completed',
      elapsed: formatElapsed(Date.now() - startedAt),
    },
    transcript,
  );
  await client.cardkit.v1.card.update({
    path: { card_id: cardId },
    data: buildCardUpdateData(finalCardJson, sequence),
  });
  console.log('[feishu:card:test] final card update ok:', { cardId, sequence });
}

async function sendDiagnosticPermissionCard(client: lark.Client, chatId: string): Promise<void> {
  const content = buildPermissionButtonCard(
    [
      '## Feishu Permission Card Test',
      '',
      '这是一张诊断卡，不会触发真实审批。',
      '请随便点一个按钮，验证 `diag:` callback 是否能被 bridge 记录并回 toast。',
    ].join('\n'),
    'diag-live',
    chatId,
    'diag',
  );

  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content,
    },
  });

  console.log('[feishu:card:test] diagnostic permission card sent:', res?.data?.message_id || 'unknown');
}

async function main(): Promise<void> {
  const { mode, chatId: explicitChatId } = parseArgs(process.argv.slice(2));
  const { client, domain } = await createClient();
  const chatId = resolveTargetChatId(explicitChatId);

  warnIfDaemonStopped();
  console.log('[feishu:card:test] target chat:', chatId);
  console.log('[feishu:card:test] domain:', domain.baseUrl);
  console.log('[feishu:card:test] mode:', mode);

  if (mode === 'static' || mode === 'all') {
    await sendStaticCard(client, chatId);
    await sleep(300);
  }

  if (mode === 'stream' || mode === 'all') {
    await sendStreamingCard(client, chatId);
    await sleep(300);
  }

  if (mode === 'permission' || mode === 'all') {
    await sendDiagnosticPermissionCard(client, chatId);
  }
}

main().catch((err) => {
  console.error('[feishu:card:test] failed:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
