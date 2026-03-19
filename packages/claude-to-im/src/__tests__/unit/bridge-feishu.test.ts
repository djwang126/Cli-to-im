import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import {
  FEISHU_STREAMING_ELEMENT_ID,
  buildCardSettingsData,
  buildCardUpdateData,
  resolveFeishuDomain,
} from '../../lib/bridge/adapters/feishu-cardkit';
import {
  FEISHU_THINKING_MARKER,
  buildFinalCardJson,
  buildPermissionButtonCard,
  buildStreamingContent,
  buildStreamingCardJson,
} from '../../lib/bridge/markdown/feishu';

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: any[] = [];

  return {
    auditLogs,
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
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
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

type MockStore = ReturnType<typeof createMockStore>;

function setupContext(store: MockStore) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function buildMockRestClient(calls: Array<{ name: string; payload: any }>) {
  return {
    cardkit: {
      v1: {
        card: {
          create: async (payload: any) => {
            calls.push({ name: 'card.create', payload });
            return { data: { card_id: 'card-1' } };
          },
          settings: async (payload: any) => {
            calls.push({ name: 'card.settings', payload });
            return {};
          },
          update: async (payload: any) => {
            calls.push({ name: 'card.update', payload });
            return {};
          },
        },
        cardElement: {
          content: async (payload: any) => {
            calls.push({ name: 'cardElement.content', payload });
            return {};
          },
        },
      },
    },
    im: {
      message: {
        create: async (payload: any) => {
          calls.push({ name: 'im.message.create', payload });
          return { data: { message_id: 'msg-create-1' } };
        },
        reply: async (payload: any) => {
          calls.push({ name: 'im.message.reply', payload });
          return { data: { message_id: 'msg-reply-1' } };
        },
      },
      messageReaction: {
        create: async () => ({ data: { reaction_id: 'reaction-1' } }),
        delete: async () => ({}),
      },
    },
  };
}

describe('feishu card helpers', () => {
  it('resolves Feishu and Lark domains from aliases and URLs', () => {
    assert.equal(resolveFeishuDomain('feishu').baseUrl, 'https://open.feishu.cn');
    assert.equal(resolveFeishuDomain('https://open.feishu.cn').key, 'feishu');
    assert.equal(resolveFeishuDomain('lark').baseUrl, 'https://open.larksuite.com');
    assert.equal(resolveFeishuDomain('https://open.larksuite.com').key, 'lark');
  });

  it('builds CardKit v1 settings/update payloads and schema 2.0 streaming JSON', () => {
    const cardJson = JSON.parse(buildStreamingCardJson());
    assert.equal(cardJson.schema, '2.0');
    assert.equal(cardJson.config.streaming_mode, true);
    assert.equal(cardJson.body.elements[0].element_id, FEISHU_STREAMING_ELEMENT_ID);

    const settings = buildCardSettingsData({ streaming_mode: false }, 3);
    assert.equal(settings.sequence, 3);
    assert.deepEqual(JSON.parse(settings.settings), { config: { streaming_mode: false } });

    const update = buildCardUpdateData('{"schema":"2.0"}', 4);
    assert.equal(update.sequence, 4);
    assert.equal(update.card.type, 'card_json');
    assert.equal(update.card.data, '{"schema":"2.0"}');
  });

  it('builds final cards that preserve streamed text and timeline', () => {
    const card = JSON.parse(buildFinalCardJson(
      '第一段正文\n\n第二段正文',
      [{ id: 'tool-1', name: 'workspace.scan', status: 'complete' }],
      { status: '✅ Completed', elapsed: '1.2s' },
      [
        { kind: 'text', content: '第一段正文' },
        { kind: 'text', content: '第二段正文' },
      ],
    ));

    const elements = card.body.elements;
    assert.equal(elements[0].tag, 'markdown');
    assert.equal(elements[0].content, '第一段正文\n\n第二段正文');
    const footer = elements.find((el: any) => el.text_size === 'notation');
    assert.ok(String(footer.content).includes('Completed'));
    assert.ok(String(footer.content).includes('1.2s'));
  });

  it('uses the same chronological rule for streaming content', () => {
    const content = buildStreamingContent([
      { kind: 'text', content: '第一段正文' },
      { kind: 'tools', content: FEISHU_THINKING_MARKER },
      { kind: 'text', content: '第二段正文' },
    ]);

    assert.equal(content, `第一段正文\n\n${FEISHU_THINKING_MARKER}\n\n第二段正文`);
  });

  it('supports diagnostic callback namespace in permission cards', () => {
    const card = JSON.parse(buildPermissionButtonCard('diag text', 'diag-live', 'chat-1', 'diag'));
    const rows = card.body.elements.filter((el: any) => el.tag === 'column_set');
    assert.equal(rows.length, 3);
    const callbackValues = rows.map((row: any) => row.columns[0].elements[0].value.callback_data);
    assert.deepEqual(callbackValues, [
      'diag:allow:diag-live',
      'diag:allow_session:diag-live',
      'diag:deny:diag-live',
    ]);
  });
});

describe('FeishuAdapter send paths', () => {
  let store: MockStore;
  let adapter: any;
  let calls: Array<{ name: string; payload: any }>;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
    calls = [];
    adapter = new FeishuAdapter() as any;
    adapter.restClient = buildMockRestClient(calls);
  });

  it('sends complex markdown as an interactive card', async () => {
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '```ts\nconsole.log(1)\n```',
      parseMode: 'Markdown',
    });

    assert.equal(result.ok, true);
    const sent = calls.find((entry) => entry.name === 'im.message.create');
    assert.equal(sent?.payload?.data?.msg_type, 'interactive');
    const card = JSON.parse(sent?.payload?.data?.content);
    assert.equal(card.schema, '2.0');
  });

  it('sends permission prompts as button cards', async () => {
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'chat-1' },
      text: '<b>Need permission</b>',
      parseMode: 'HTML',
      inlineButtons: [[
        { text: 'Allow', callbackData: 'perm:allow:perm-1' },
      ]],
    });

    assert.equal(result.ok, true);
    const sent = calls.find((entry) => entry.name === 'im.message.create');
    assert.equal(sent?.payload?.data?.msg_type, 'interactive');
    const card = JSON.parse(sent?.payload?.data?.content);
    const rows = card.body.elements.filter((el: any) => el.tag === 'column_set');
    assert.equal(rows.length, 3);
    const callbacks = rows.map((row: any) => row.columns[0].elements[0].value.callback_data);
    assert.deepEqual(callbacks, [
      'perm:allow:perm-1',
      'perm:allow_session:perm-1',
      'perm:deny:perm-1',
    ]);
  });
});

describe('FeishuAdapter streaming card lifecycle', () => {
  let store: MockStore;
  let adapter: any;
  let calls: Array<{ name: string; payload: any }>;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
    calls = [];
    adapter = new FeishuAdapter() as any;
    adapter.restClient = buildMockRestClient(calls);
  });

  it('uses CardKit v1 create -> content -> settings sequence and skips full refresh when content already matches', async () => {
    const created = await adapter.createStreamingCard('chat-1', 'reply-1');
    assert.equal(created, true);

    adapter.onStreamText('chat-1', 'Hello from stream');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', 'Hello from final card');
    assert.equal(finalized, true);

    assert.deepEqual(
      calls.map((entry) => entry.name),
      [
        'card.create',
        'im.message.reply',
        'cardElement.content',
        'card.settings',
      ],
    );

    const createPayload = calls[0].payload;
    const createdCard = JSON.parse(createPayload.data.data);
    assert.equal(createdCard.body.elements[0].element_id, FEISHU_STREAMING_ELEMENT_ID);

    const contentPayload = calls[2].payload;
    assert.equal(contentPayload.path.element_id, FEISHU_STREAMING_ELEMENT_ID);
    assert.equal(contentPayload.data.sequence, 1);

    const settingsPayload = calls[3].payload;
    assert.deepEqual(JSON.parse(settingsPayload.data.settings), { config: { streaming_mode: false } });
    assert.ok(!calls.some((entry) => entry.name === 'card.update'));
  });

  it('shows a temporary thinking marker during tool phases and removes it once text resumes', async () => {
    const created = await adapter.createStreamingCard('chat-1', 'reply-1');
    assert.equal(created, true);

    adapter.onStreamText('chat-1', '第一段');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'workspace.scan', status: 'running' }]);
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'workspace.scan', status: 'running' }]);
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'workspace.scan', status: 'complete' }]);
    adapter.onToolEvent('chat-1', [
      { id: 'tool-1', name: 'workspace.scan', status: 'complete' },
      { id: 'tool-2', name: 'cardkit.update', status: 'running' },
    ]);
    adapter.onStreamText('chat-1', '第一段\n\n第二段');

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '第一段\n\n第二段');
    assert.equal(finalized, true);

    const streamingContents = calls
      .filter((entry) => entry.name === 'cardElement.content')
      .map((entry) => entry.payload.data.content);
    assert.ok(streamingContents.some((content) => content === `第一段\n\n${FEISHU_THINKING_MARKER}`));
    assert.equal(streamingContents[streamingContents.length - 1], '第一段\n\n第二段');
    assert.ok(!calls.some((entry) => entry.name === 'card.update'));
  });

  it('does not perform a full-card refresh on completed streams even if a thinking marker was shown', async () => {
    const created = await adapter.createStreamingCard('chat-1', 'reply-1');
    assert.equal(created, true);

    adapter.onStreamText('chat-1', '第一段');
    adapter.onToolEvent('chat-1', [{ id: 'tool-1', name: 'workspace.scan', status: 'running' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const finalized = await adapter.onStreamEnd('chat-1', 'completed', '第一段');
    assert.equal(finalized, true);

    const streamingContents = calls
      .filter((entry) => entry.name === 'cardElement.content')
      .map((entry) => entry.payload.data.content);
    assert.ok(streamingContents.includes(`第一段\n\n${FEISHU_THINKING_MARKER}`));
    assert.ok(!calls.some((entry) => entry.name === 'card.update'));
  });

  it('returns false instead of throwing when card creation fails', async () => {
    adapter.restClient.cardkit.v1.card.create = async () => {
      throw new Error('boom');
    };

    const created = await adapter.createStreamingCard('chat-1', 'reply-1');
    assert.equal(created, false);
    assert.equal(adapter.activeCards.size, 0);
  });
});

describe('FeishuAdapter card action callbacks', () => {
  let store: MockStore;
  let adapter: any;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
    adapter = new FeishuAdapter() as any;
  });

  it('logs diagnostic callbacks without enqueueing permission work', async () => {
    const result = await adapter.handleCardAction({
      action: { value: { callback_data: 'diag:allow:diag-live', chatId: 'chat-1' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om-1' },
      operator: { open_id: 'ou-1' },
    });

    assert.deepEqual(result, {
      toast: {
        type: 'info',
        content: '诊断按钮已收到：allow',
      },
    });
    assert.equal(adapter.queue.length, 0);
    assert.equal(store.auditLogs.length, 1);
    assert.equal(store.auditLogs[0].summary, '[DIAG] diag:allow:diag-live');
  });

  it('keeps perm callbacks on the normal permission queue', async () => {
    const result = await adapter.handleCardAction({
      action: { value: { callback_data: 'perm:allow:perm-1', chatId: 'chat-1' } },
      context: { open_chat_id: 'chat-1', open_message_id: 'om-1' },
      operator: { open_id: 'ou-1' },
    });

    assert.deepEqual(result, {
      toast: {
        type: 'info',
        content: '已收到，正在处理...',
      },
    });
    assert.equal(adapter.queue.length, 1);
    assert.equal(adapter.queue[0].callbackData, 'perm:allow:perm-1');
  });
});
