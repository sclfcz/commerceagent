import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-inbox-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const controls = vi.hoisted(() => ({
  dispatchers: [] as Array<Record<string, (data: any) => Promise<unknown>>>,
  backfillItems: [] as any[],
  messageList: vi.fn(),
  messageGet: vi.fn(),
  messageResourceGet: vi.fn(),
  chatList: vi.fn(),
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot', app_name: 'Inbox Test Bot' },
    });
    im = {
      v1: {
        chat: { list: controls.chatList },
        message: {
          list: controls.messageList,
          get: controls.messageGet,
          create: controls.messageCreate,
        },
        messageReaction: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { reaction_id: 'reaction_1' },
          }),
          delete: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
      message: {
        reply: controls.messageReply,
      },
      messageReaction: {
        create: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
      messageResource: { get: controls.messageResourceGet },
    };
  },
  EventDispatcher: class {
    private readonly handlers: Record<string, (data: any) => Promise<unknown>> =
      {};
    constructor() {
      controls.dispatchers.push(this.handlers);
    }
    register(input: Record<string, (data: any) => Promise<unknown>>) {
      Object.assign(this.handlers, input);
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { createFeishuConnection } = await import('../src/feishu.js');
const { ChannelRouteRejectedError } =
  await import('../src/channel-admission.js');
const { getChannelCursor, recordChannelInbox } =
  await import('../src/channel-reliability-store.js');

const openConnections: Array<{ stop(): Promise<void> }> = [];

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:durable-feishu-test', {
    name: 'Durable Feishu Test',
    folder: 'durable-feishu-test',
    added_at: new Date().toISOString(),
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  controls.dispatchers.length = 0;
  controls.backfillItems = [];
  controls.chatList.mockReset().mockResolvedValue({
    data: { items: [], has_more: false },
  });
  controls.messageList.mockReset().mockImplementation(async () => ({
    data: { items: controls.backfillItems, has_more: false },
  }));
  controls.messageGet.mockReset().mockResolvedValue({ data: { items: [] } });
  controls.messageCreate.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
  controls.messageReply.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
  controls.messageResourceGet.mockReset().mockResolvedValue({
    getReadableStream: () =>
      (async function* () {
        yield Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      })(),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    openConnections.splice(0).map((item) => item.stop()),
  );
});

function event(messageId: string, createTimeMs: number, text: string) {
  return {
    message: {
      chat_id: 'ou_durable_user',
      message_id: messageId,
      create_time: String(createTimeMs),
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_type: 'p2p',
    },
    sender: {
      sender_id: { open_id: 'ou_durable_user' },
      sender_type: 'user',
      sender_name: 'Durable User',
    },
  };
}

function backfillItem(messageId: string, createTimeMs: number, text: string) {
  return {
    message_id: messageId,
    create_time: String(createTimeMs),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    chat_type: 'p2p',
    sender: {
      sender_type: 'user',
      name: 'Durable User',
      sender_id: { open_id: 'ou_durable_user' },
    },
  };
}

type TestConnectOptions = Parameters<
  ReturnType<typeof createFeishuConnection>['connect']
>[0];

async function connect(
  accountId: string,
  executed: ReturnType<typeof vi.fn>,
  overrides: Partial<TestConnectOptions> = {},
) {
  const connection = createFeishuConnection({
    appId: 'app_durable',
    appSecret: 'secret',
    channelAccountId: accountId,
  });
  const dispatcherIndex = controls.dispatchers.length;
  expect(
    await connection.connect({
      onReady: vi.fn(),
      ignoreMessagesBefore: Date.now() + 60_000,
      resolveEffectiveChatJid: (jid) => ({
        effectiveJid: 'web:durable-feishu-test',
        agentId: null,
        sourceJid: jid,
      }),
      onFollowUpMessage: (input) => {
        executed(input.messageId);
        return { disposition: 'started' as const };
      },
      ...overrides,
    }),
  ).toBe(true);
  openConnections.push(connection);
  const handler =
    controls.dispatchers[dispatcherIndex]?.['im.message.receive_v1'];
  expect(handler).toBeTypeOf('function');
  return {
    connection,
    handler,
    handlers: controls.dispatchers[dispatcherIndex]!,
  };
}

describe('Feishu durable Inbox and cursor integration', () => {
  test('bootstraps the first P2P DM after an account-scoped route rejection', async () => {
    const accountId = `account-first-dm-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    let registered = false;
    onNewChat.mockImplementation(() => {
      registered = true;
    });
    const resolveEffectiveChatJid = vi.fn((jid: string) => {
      if (!registered) throw new ChannelRouteRejectedError(jid);
      return {
        effectiveJid: 'web:durable-feishu-test',
        agentId: null,
        sourceJid: jid,
      };
    });
    const connected = await connect(accountId, executed, {
      normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: () => true,
      onNewChat,
      onP2pSender,
    });

    await connected.handler(event('om_first_dm', Date.now(), 'hello'));

    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveChatJid).toHaveBeenNthCalledWith(
      1,
      `feishu:ou_durable_user#account:${accountId}`,
    );
    expect(onNewChat).toHaveBeenCalledWith(
      `feishu:ou_durable_user#account:${accountId}`,
      '飞书私聊',
    );
    expect(onP2pSender).toHaveBeenCalledWith('ou_durable_user');
    expect(executed).toHaveBeenCalledWith('om_first_dm');
  });

  test('rejects a known-owner mismatch before P2P registration or routing', async () => {
    const accountId = `account-owner-gate-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    const resolveEffectiveChatJid = vi.fn();
    const connected = await connect(accountId, executed, {
      normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: (_jid, sender) => sender === 'ou_owner',
      onNewChat,
      onP2pSender,
    });

    await connected.handler(
      event('om_non_owner_first_dm', Date.now(), 'not the owner'),
    );

    expect(onNewChat).not.toHaveBeenCalled();
    expect(onP2pSender).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  test('does not bootstrap P2P registration after an unrelated route failure', async () => {
    const accountId = `account-route-error-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    const resolveEffectiveChatJid = vi.fn(() => {
      throw new Error('route storage unavailable');
    });
    const connected = await connect(accountId, executed, {
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: () => true,
      onNewChat,
      onP2pSender,
    });

    await connected.handler(
      event('om_route_error', Date.now(), 'do not register'),
    );

    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onP2pSender).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  test('does not register an owner merely because a user opens the P2P chat', async () => {
    const accountId = `account-no-enter-claim-${Date.now()}`;
    const connected = await connect(accountId, vi.fn(), {
      onNewChat: vi.fn(),
      onP2pSender: vi.fn(),
    });

    expect(
      connected.handlers['im.chat.access_event.bot_p2p_chat_entered_v1'],
    ).toBeUndefined();
  });

  test('recovery gate queues a live event and executes it only after the gate opens', async () => {
    const accountId = `account-recovery-gate-${Date.now()}`;
    const executed = vi.fn();
    let deferred = true;
    const connected = await connect(accountId, executed, {
      shouldDeferInbound: () => deferred,
    });
    vi.useFakeTimers();

    await connected.handler(
      event('om_during_recovery_gate', Date.now(), 'wait for recovery'),
    );
    expect(executed).not.toHaveBeenCalled();
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_during_recovery_gate',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('queued');

    deferred = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_during_recovery_gate');
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_during_recovery_gate',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('downloads a merged-forward child image using the child owner message id', async () => {
    const accountId = `account-forward-image-${Date.now()}`;
    const executed = vi.fn();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_forward_owner_test',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_child_image',
            upper_message_id: 'om_forward_owner_test',
            msg_type: 'image',
            body: {
              content: JSON.stringify({ image_key: 'img_child_owned' }),
            },
          },
        ],
      },
    });
    const connected = await connect(accountId, executed);

    await connected.handler({
      ...event('om_forward_owner_test', Date.now(), ''),
      message: {
        ...event('om_forward_owner_test', Date.now(), '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });

    expect(controls.messageResourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {
          message_id: 'om_forward_child_image',
          file_key: 'img_child_owned',
        },
        params: { type: 'image' },
      }),
    );
    expect(executed).toHaveBeenCalledWith('om_forward_owner_test');
  });

  test('two live instances concurrently execute one external message exactly once', async () => {
    const accountId = `account-concurrent-${Date.now()}`;
    const executed = vi.fn();
    const first = await connect(accountId, executed);
    const second = await connect(accountId, executed);
    const createTime = Date.now() - 30_000;

    await Promise.all([
      first.handler(event('om_concurrent', createTime, 'once')),
      second.handler(event('om_concurrent', createTime, 'once')),
    ]);

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_concurrent');
    const duplicate = recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: 'om_concurrent',
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      status: 'queued',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.item.status).toBe('processed');
  });

  test('restart backfills downtime messages from the durable cursor despite the legacy ignore threshold', async () => {
    const accountId = `account-restart-${Date.now()}`;
    const executed = vi.fn();
    const base = Date.now() - 120_000;
    const first = await connect(accountId, executed);
    await first.handler(event('om_before_restart', base, 'before'));
    await first.connection.stop();
    openConnections.splice(openConnections.indexOf(first.connection), 1);

    controls.backfillItems = [
      backfillItem('om_during_downtime', base + 30_000, 'during'),
      backfillItem('om_before_restart', base, 'before'),
    ];
    await connect(accountId, executed);

    expect(executed.mock.calls.map(([id]) => id)).toEqual([
      'om_before_restart',
      'om_during_downtime',
    ]);
    const cursor = getChannelCursor({
      provider: 'feishu',
      accountId,
      scope: 'chat_messages',
      chatId: 'ou_durable_user',
    });
    expect(cursor?.cursor).toBe('om_during_downtime');
    expect(cursor?.position).toBe(base + 30_000);
  });

  test('cursor backfill keeps a safety window so late older events are not skipped', async () => {
    const accountId = `account-late-${Date.now()}`;
    const executed = vi.fn();
    const newestTime = Date.now() - 10_000;
    const lateTime = newestTime - 4 * 60_000;
    controls.messageList.mockImplementation(async (request: any) => {
      const startMs = Number(request.params.start_time) * 1_000;
      return {
        data: {
          items: controls.backfillItems.filter(
            (item) => Number(item.create_time) >= startMs,
          ),
          has_more: false,
        },
      };
    });

    const first = await connect(accountId, executed);
    await first.handler(event('om_newest_cursor', newestTime, 'newest'));
    await first.connection.stop();
    openConnections.splice(openConnections.indexOf(first.connection), 1);

    controls.backfillItems = [
      backfillItem('om_late_older', lateTime, 'arrived late'),
      backfillItem('om_newest_cursor', newestTime, 'newest'),
    ];
    await connect(accountId, executed);

    expect(executed.mock.calls.map(([id]) => id)).toEqual([
      'om_newest_cursor',
      'om_late_older',
    ]);
    expect(
      getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId: 'ou_durable_user',
      })?.cursor,
    ).toBe('om_newest_cursor');
  });

  test('startup inventory makes a known group eligible for backfill before onReady', async () => {
    const accountId = `account-inventory-${Date.now()}`;
    const executed = vi.fn();
    const createTime = Date.now() - 10_000;
    controls.chatList.mockResolvedValue({
      data: {
        items: [
          {
            chat_id: 'oc_known_group',
            name: 'Known Group',
            chat_type: 'group',
          },
        ],
        has_more: false,
      },
    });
    controls.backfillItems = [
      {
        ...backfillItem('om_group_downtime', createTime, 'group downtime'),
        chat_type: 'group',
      },
    ];

    await connect(accountId, executed);

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_group_downtime');
    expect(
      getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId: 'oc_known_group',
      })?.cursor,
    ).toBe('om_group_downtime');
  });

  test('an intake exception stays queued and is automatically retried', async () => {
    vi.useFakeTimers();
    const accountId = `account-retry-${Date.now()}`;
    const executed = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient intake failure');
      })
      .mockImplementation(() => undefined);
    const connected = await connect(accountId, executed);
    const createTime = Date.now();

    await connected.handler(event('om_retry', createTime, 'retry me'));
    expect(executed).toHaveBeenCalledTimes(1);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_retry',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('queued');

    await vi.advanceTimersByTimeAsync(5_100);

    expect(executed).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_retry',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('heartbeat fences a slow command beyond the original lease from a second instance', async () => {
    vi.useFakeTimers();
    const accountId = `account-heartbeat-${Date.now()}`;
    const executed = vi.fn();
    let releaseCommand!: (reply: string | null) => void;
    const onCommand = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          releaseCommand = resolve;
        }),
    );
    const first = await connect(accountId, executed, { onCommand });
    await connect(accountId, executed, { onCommand });

    const pending = first.handler(
      event('om_slow_command', Date.now(), '/slow'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onCommand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(onCommand).toHaveBeenCalledTimes(1);

    releaseCommand('done');
    await pending;
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_slow_command',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command Inbox completes only after a successful provider ACK', async () => {
    const accountId = `account-command-ack-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    const connected = await connect(accountId, executed, { onCommand });

    await connected.handler(event('om_command_ack', Date.now(), '/status'));

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({
          receive_id: 'ou_durable_user',
          msg_type: 'text',
          content: JSON.stringify({ text: 'command reply' }),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_ack',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command API failure remains durable and is never marked processed', async () => {
    vi.useFakeTimers();
    const accountId = `account-command-api-failure-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    controls.messageCreate.mockResolvedValueOnce({
      code: 23_001,
      msg: 'connector unavailable',
    });
    const connected = await connect(accountId, executed, { onCommand });

    await connected.handler(
      event('om_command_api_failure', Date.now(), '/status'),
    );

    expect(onCommand).toHaveBeenCalledTimes(1);
    // A resolved non-zero API code is a definitive rejection, so the durable
    // reply may return to pending_reply and be retried without re-running the
    // command.
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_api_failure',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'queued',
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'pending_reply',
        command: 'status',
        replyText: 'command reply',
      },
    });

    await vi.advanceTimersByTimeAsync(5_100);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_api_failure',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command API timeout remains durable and is never marked processed', async () => {
    vi.useFakeTimers();
    const accountId = `account-command-timeout-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    controls.messageCreate.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const connected = await connect(accountId, executed, { onCommand });

    const pending = connected.handler(
      event('om_command_timeout', Date.now(), '/status'),
    );
    await vi.advanceTimersByTimeAsync(15_100);
    await pending;

    expect(onCommand).toHaveBeenCalledTimes(1);
    // The second send is a distinct manual-reconciliation notice, never the
    // persisted command reply.
    expect(controls.messageCreate).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_timeout',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation'),
      normalizedPayload: expect.objectContaining({ state: 'sending_reply' }),
    });
  });

  test('restart recovers a persisted command reply without executing the command again', async () => {
    const accountId = `account-command-restart-${Date.now()}`;
    const messageId = 'om_command_restart_pending_reply';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/status' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'pending_reply',
        command: 'status',
        replyTarget: 'ou_durable_user',
        replyText: 'persisted reply',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: JSON.stringify({ text: 'persisted reply' }),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('restart never re-executes a command interrupted before result persistence', async () => {
    const accountId = `account-command-interrupted-${Date.now()}`;
    const messageId = 'om_command_interrupted_executing';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/dangerous' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'executing',
        command: 'dangerous',
        replyTarget: 'ou_durable_user',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining('避免重复执行'),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation required'),
    });
  });

  test('restart never resends a reply after provider acceptance but before ACK persistence', async () => {
    const accountId = `account-command-send-crash-${Date.now()}`;
    const messageId = 'om_command_provider_accepted_before_checkpoint';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/dangerous' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'sending_reply',
        command: 'dangerous',
        replyTarget: 'ou_durable_user',
        replyText: 'provider already accepted this reply',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    const sentContent = controls.messageCreate.mock.calls.map(
      ([request]) => request.data.content,
    );
    expect(sentContent).not.toContain(
      JSON.stringify({ text: 'provider already accepted this reply' }),
    );
    expect(sentContent.join('\n')).toContain('可能已经送达');
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation required'),
      normalizedPayload: expect.objectContaining({ state: 'sending_reply' }),
    });
  });
});
