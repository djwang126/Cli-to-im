import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type { BridgeMessage, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

function createStore(messages: BridgeMessage[]): BridgeStore {
  return {
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => ({ id: 'session-1', working_directory: 'D:/workspaces/AI-Tools', model: '' }),
    createSession: () => ({ id: 'session-1', working_directory: 'D:/workspaces/AI-Tools', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: (_sessionId, role, content) => {
      messages.push({ role, content });
    },
    getMessages: () => ({ messages: [...messages] }),
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

describe('conversation-engine assistant_message handling', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('keeps only the latest replace-style assistant message for Codex streams', async () => {
    const messages: BridgeMessage[] = [];
    const store = createStore(messages);

    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(sseEvent('assistant_message', '进度说明'));
        controller.enqueue(sseEvent('tool_use', {
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'Get-ChildItem' },
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: 'tool-1',
          content: 'Done',
          is_error: false,
        }));
        controller.enqueue(sseEvent('assistant_message', '最终结论'));
        controller.enqueue(sseEvent('result', { usage: { input_tokens: 1, output_tokens: 2 } }));
        controller.close();
      },
    });

    initBridgeContext({
      store,
      llm: { streamChat: () => stream },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding: ChannelBinding = {
      id: 'binding-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: 'D:/workspaces/AI-Tools',
      model: '',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await processMessage(binding, '请分析');

    assert.equal(result.responseText, '最终结论');
    assert.equal(messages.length, 2, 'Should save one user message and one assistant message');

    const savedBlocks = JSON.parse(messages[1].content) as Array<Record<string, unknown>>;
    const textBlocks = savedBlocks.filter((block) => block.type === 'text');
    assert.deepEqual(textBlocks, [{ type: 'text', text: '最终结论' }]);
    assert.equal(savedBlocks.some((block) => JSON.stringify(block).includes('进度说明')), false);
  });
});
