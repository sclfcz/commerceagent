import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  formatChannelTurnContextForPrompt,
  normalizeChannelTurnContext,
  type ChannelTurnContext,
} from '../container/agent-runner/src/types.js';
import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function feishuContext(messageId = 'om-trigger'): ChannelTurnContext {
  return {
    schemaVersion: 1,
    provider: 'feishu',
    sourceJid:
      'feishu:oc_group#account:account-2#thread:omt_thread#root:om_root',
    channelAccountId: 'account-2',
    bot: {
      appId: 'cli_bot_2',
      openId: 'ou_bot_2',
      name: 'E2E Bot',
    },
    chat: {
      id: 'oc_group',
      type: 'group',
      name: 'AIAM-E2E-话题测试群',
      isTopicStyle: true,
    },
    message: {
      id: messageId,
      rootId: 'om_root',
      threadId: 'omt_thread',
    },
    sender: {
      openId: 'ou_sender',
      userId: 'u_sender',
      unionId: 'on_sender',
      name: '测试用户',
      tenantKey: 'tenant-1',
    },
    capabilities: ['feishu.get_chat', 'feishu.send_card'],
  };
}

function setup(contextValue: ChannelTurnContext = feishuContext()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-context-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: contextValue.sourceJid,
    channelContext: contextValue,
    groupFolder: 'workspace',
    isHome: true,
    isAdminHome: true,
    agentBuilderEnabled: false,
    currentInputTurnId: 'delivery-1',
    workspaceIpc: root,
    workspaceGroup: root,
  };
  return { root, context, tools: createMcpTools(context) };
}

async function readCapabilityRequest(
  root: string,
): Promise<Record<string, unknown>> {
  const tasksDir = path.join(root, 'tasks');
  let filename = '';
  await vi.waitFor(() => {
    filename = fs
      .readdirSync(tasksDir)
      .find((candidate) => candidate.endsWith('.json'))!;
    expect(filename).toBeTruthy();
  });
  return JSON.parse(fs.readFileSync(path.join(tasksDir, filename), 'utf8'));
}

describe('Agent Runner channel turn context', () => {
  test('normalizes a complete Feishu context and discards unknown credential fields', () => {
    const normalized = normalizeChannelTurnContext({
      ...feishuContext(),
      accessToken: 'must-not-cross-boundary',
      appSecret: 'must-not-cross-boundary',
      bot: {
        ...feishuContext().bot,
        tenantAccessToken: 'must-not-cross-boundary',
      },
      message: {
        ...feishuContext().message,
        referencedMessages: [
          { id: 'om-parent', text: 'prompt-only quoted body' },
        ],
      },
    });

    expect(normalized).toMatchObject({
      provider: 'feishu',
      channelAccountId: 'account-2',
      chat: { id: 'oc_group', isTopicStyle: true },
      message: { id: 'om-trigger', threadId: 'omt_thread' },
      sender: { openId: 'ou_sender', userId: 'u_sender' },
    });
    expect(JSON.stringify(normalized)).not.toContain('must-not-cross-boundary');
    expect(JSON.stringify(normalized)).not.toContain('prompt-only quoted body');
  });

  test('creates a compact host-verified per-turn prompt block', () => {
    const prompt = formatChannelTurnContextForPrompt(feishuContext());
    expect(prompt).toContain(
      '<channel_context source="commerceagent_host" trust="verified">',
    );
    expect(prompt).toContain('"threadId":"omt_thread"');
    expect(prompt).toContain('"openId":"ou_sender"');
    expect(prompt).toContain('Never guess IDs or credentials');
  });

  test('get_channel_context observes mutable warm-turn context', async () => {
    const { context, tools } = setup();
    const getContext = tools.find(
      (candidate) => candidate.name === 'get_channel_context',
    )!;
    const first = await getContext.handler({}, {} as never);
    expect(first.content[0].text).toContain('om-trigger');

    context.chatJid = 'feishu:oc_other#account:account-3';
    context.channelContext = feishuContext('om-next');
    context.channelContext.sourceJid = context.chatJid;
    context.channelContext.channelAccountId = 'account-3';
    const next = await getContext.handler({}, {} as never);
    expect(next.content[0].text).toContain('om-next');
    expect(next.content[0].text).toContain('account-3');
    expect(next.content[0].text).not.toContain('om-trigger');
  });

  test('registers the typed Feishu broker surface', () => {
    const { tools } = setup();
    expect(tools.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'feishu_get_chat',
        'feishu_list_members',
        'feishu_get_user',
        'feishu_get_history',
        'feishu_send_card',
        'feishu_add_reaction',
        'feishu_remove_reaction',
        'feishu_edit_message',
        'feishu_recall_message',
        'feishu_api_request',
      ]),
    );
  });

  test('stamps broker requests from current runner state, not model arguments', async () => {
    const { root, tools } = setup();
    const getChat = tools.find(
      (candidate) => candidate.name === 'feishu_get_chat',
    )!;
    const pending = getChat.handler({}, {} as never);
    const request = await readCapabilityRequest(root);

    expect(request).toMatchObject({
      type: 'feishu_capability',
      operation: 'get_chat',
      chatJid:
        'feishu:oc_group#account:account-2#thread:omt_thread#root:om_root',
      inputTurnId: 'delivery-1',
      params: {},
    });
    expect(request).not.toHaveProperty('accessToken');
    expect(request).not.toHaveProperty('appSecret');

    fs.writeFileSync(
      path.join(
        root,
        'tasks',
        `feishu_capability_result_${request.requestId}.json`,
      ),
      JSON.stringify({ success: true, chat: { chatId: 'oc_group' } }),
    );
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining('oc_group') }),
      ],
    });
  });

  test('rejects Feishu operations locally outside a Feishu turn', async () => {
    const webContext = normalizeChannelTurnContext(undefined, 'web:main')!;
    const { root, tools } = setup(webContext);
    const getChat = tools.find(
      (candidate) => candidate.name === 'feishu_get_chat',
    )!;
    await expect(getChat.handler({}, {} as never)).rejects.toThrow(
      'unavailable for the current web turn',
    );
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false);
  });
});
