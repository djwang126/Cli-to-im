/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });
});

describe('bridge-manager codex config helpers', () => {
  it('writeCodexDefaultModelConfig upserts model settings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-codex-config-'));
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(configPath, '[features]\nmulti_agent = true\n', 'utf-8');

    const { writeCodexDefaultModelConfig } = await import('../../lib/bridge/bridge-manager');
    writeCodexDefaultModelConfig('gpt-5.5', 'medium', configPath);

    const updated = fs.readFileSync(configPath, 'utf-8');
    assert.match(updated, /^model = "gpt-5.5"/m);
    assert.match(updated, /^model_reasoning_effort = "medium"/m);
    assert.match(updated, /^\[features\]$/m);
  });

  it('triggerBridgeRestart throws when the script is missing', async () => {
    const { triggerBridgeRestart } = await import('../../lib/bridge/bridge-manager');
    assert.throws(() => {
      triggerBridgeRestart(path.join(os.tmpdir(), 'missing-restart-bridge.bat'));
    }, /Restart script not found/);
  });
});

class MockFeishuCommandAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';
  readonly sentMessages: OutboundMessage[] = [];
  readonly browserCalls: Array<{
    chatId: string;
    currentPath: string;
    entries: Array<{ label: string; actionLabel: 'Open' | 'Send'; callbackData: string }>;
    notice?: string;
  }> = [];
  readonly fileCalls: Array<{ chatId: string; absolutePath: string }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: 'sent-1' };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }

  async sendFileBrowserCard(
    chatId: string,
    currentPath: string,
    entries: Array<{ label: string; actionLabel: 'Open' | 'Send'; callbackData: string }>,
    notice?: string,
  ): Promise<SendResult> {
    this.browserCalls.push({ chatId, currentPath, entries, notice });
    return { ok: true, messageId: 'browser-1' };
  }

  async sendLocalFile(chatId: string, absolutePath: string): Promise<SendResult> {
    this.fileCalls.push({ chatId, absolutePath });
    return { ok: true, messageId: 'file-1' };
  }
}

describe('bridge-manager /file command', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('renders a Feishu file browser card for the current working directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-file-cmd-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test', 'utf8');

    try {
      const store = createCommandStore(tmpDir);
      initBridgeContext({
        store,
        llm: { streamChat: () => new ReadableStream() },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const adapter = new MockFeishuCommandAdapter();
      const { _testOnly } = await import('../../lib/bridge/bridge-manager');
      await _testOnly.handleMessage(adapter, {
        messageId: 'msg-1',
        address: { channelType: 'feishu', chatId: 'chat-1', userId: 'ou-1' },
        text: '/file',
        timestamp: Date.now(),
      });

      assert.equal(adapter.browserCalls.length, 1);
      assert.equal(adapter.browserCalls[0].currentPath, '.');
      assert.equal(adapter.browserCalls[0].entries.length, 2);
      assert.equal(adapter.browserCalls[0].entries[0].actionLabel, 'Open');
      assert.equal(adapter.browserCalls[0].entries[1].actionLabel, 'Send');
      assert.equal(adapter.sentMessages.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('sends a file directly when /file points to a file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-file-send-'));
    const filePath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(filePath, 'hello', 'utf8');

    try {
      const store = createCommandStore(tmpDir);
      initBridgeContext({
        store,
        llm: { streamChat: () => new ReadableStream() },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const adapter = new MockFeishuCommandAdapter();
      const { _testOnly } = await import('../../lib/bridge/bridge-manager');
      await _testOnly.handleMessage(adapter, {
        messageId: 'msg-2',
        address: { channelType: 'feishu', chatId: 'chat-1', userId: 'ou-1' },
        text: '/file notes.txt',
        timestamp: Date.now(),
      });

      assert.deepEqual(adapter.fileCalls, [{ chatId: 'chat-1', absolutePath: filePath }]);
      assert.equal(adapter.browserCalls.length, 0);
      assert.equal(adapter.sentMessages.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('bridge-manager /whoami command', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('returns the current user and chat identifiers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-whoami-'));

    try {
      const store = createCommandStore(tmpDir);
      initBridgeContext({
        store,
        llm: { streamChat: () => new ReadableStream() },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });

      const adapter = new MockFeishuCommandAdapter();
      const { _testOnly } = await import('../../lib/bridge/bridge-manager');
      await _testOnly.handleMessage(adapter, {
        messageId: 'msg-whoami-1',
        address: { channelType: 'feishu', chatId: 'chat-1', userId: 'ou-user-123' },
        text: '/whoami',
        timestamp: Date.now(),
      });

      assert.equal(adapter.sentMessages.length, 1);
      assert.match(adapter.sentMessages[0].text, /User ID: <code>ou-user-123<\/code>/);
      assert.match(adapter.sentMessages[0].text, /Chat ID: <code>chat-1<\/code>/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    updateSessionTurnConfig: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createCommandStore(workingDirectory: string): BridgeStore {
  const binding = {
    id: 'binding-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    codepilotSessionId: 'session-1',
    sdkSessionId: '',
    workingDirectory,
    model: '',
    mode: 'code' as const,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    getSetting: (key: string) => {
      if (key === 'bridge_default_work_dir') return workingDirectory;
      return null;
    },
    getChannelBinding: (channelType: string, chatId: string) => (channelType === 'feishu' && chatId === 'chat-1' ? binding : null),
    upsertChannelBinding: () => binding,
    updateChannelBinding: () => {},
    listChannelBindings: () => [binding],
    getSession: (id: string) => (id === 'session-1' ? { id, working_directory: workingDirectory, model: '' } : null),
    createSession: () => ({ id: 'session-1', working_directory: workingDirectory, model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    updateSessionTurnConfig: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}
