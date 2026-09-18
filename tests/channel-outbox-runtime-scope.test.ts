import { describe, expect, it } from 'vitest';

import {
  ActiveChannelOutboxScopeRegistry,
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  syntheticChannelProviderAck,
} from '../src/channel-outbox-runtime-scope.js';

const base = {
  provider: 'feishu',
  accountId: 'bot-a',
  sourceJid: 'feishu:chat-a#account:bot-a#thread:thread-a#root:root-a',
  chatId: 'chat-a',
  rootId: 'root-a',
  threadId: 'thread-a',
};

describe('active channel outbox scope', () => {
  it('isolates sibling threads and bot accounts', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    registry.bind('workspace', {
      ...base,
      turnRunId: 'turn-a',
      owner: 'owner-a',
    });

    expect(registry.resolve('workspace', base.sourceJid)?.turnRunId).toBe(
      'turn-a',
    );
    expect(
      registry.resolve(
        'workspace',
        'feishu:chat-a#account:bot-a#thread:thread-b#root:root-b',
      ),
    ).toBeNull();
    expect(
      registry.resolve(
        'workspace',
        'feishu:chat-a#account:bot-b#thread:thread-a#root:root-a',
      ),
    ).toBeNull();
  });

  it('does compare-and-delete cleanup so an old finally cannot clear a new turn', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    const old = registry.bind('workspace', {
      ...base,
      turnRunId: 'turn-old',
      inputTurnId: 'input-old',
      owner: 'owner-old',
    });
    const current = registry.bind('workspace', {
      ...base,
      turnRunId: 'turn-current',
      inputTurnId: 'input-current',
      logicalBaseChatJid: 'web:workspace-at-admission',
      owner: 'owner-current',
    });

    expect(
      registry.resolveToken('workspace', old.token, base.sourceJid)?.turnRunId,
    ).toBe('turn-old');
    expect(
      registry.resolveToken('workspace', current.token, base.sourceJid)
        ?.turnRunId,
    ).toBe('turn-current');
    expect(
      registry.resolveInput('workspace', 'input-old', base.sourceJid)?.token,
    ).toBe(old.token);
    expect(
      registry.resolveInput('workspace', 'input-current', base.sourceJid)
        ?.token,
    ).toBe(current.token);
    expect(
      registry.resolveInput('workspace', 'input-current', base.sourceJid)
        ?.logicalBaseChatJid,
    ).toBe('web:workspace-at-admission');
    expect(
      registry.resolveInput('workspace', 'input-missing', base.sourceJid),
    ).toBeNull();
    expect(registry.unbind('workspace', old)).toBe(true);
    expect(registry.resolve('workspace', base.sourceJid)?.turnRunId).toBe(
      'turn-current',
    );
    expect(registry.unbind('workspace', current)).toBe(true);
    expect(registry.resolve('workspace', base.sourceJid)).toBeNull();
  });

  it('keeps different native topics concurrently addressable in one workspace', () => {
    const registry = new ActiveChannelOutboxScopeRegistry();
    const topicA = registry.bind('workspace', {
      ...base,
      turnRunId: 'turn-topic-a',
      owner: 'owner-a',
    });
    const topicBRoute = {
      ...base,
      sourceJid: 'feishu:chat-a#account:bot-a#thread:thread-b#root:root-b',
      rootId: 'root-b',
      threadId: 'thread-b',
    };
    const topicB = registry.bind('workspace', {
      ...topicBRoute,
      turnRunId: 'turn-topic-b',
      owner: 'owner-b',
    });

    expect(registry.resolve('workspace', base.sourceJid)?.turnRunId).toBe(
      'turn-topic-a',
    );
    expect(
      registry.resolve('workspace', topicBRoute.sourceJid)?.turnRunId,
    ).toBe('turn-topic-b');
    expect(registry.unbind('workspace', topicA)).toBe(true);
    expect(
      registry.resolve('workspace', topicBRoute.sourceJid)?.turnRunId,
    ).toBe('turn-topic-b');
    expect(registry.unbind('workspace', topicB)).toBe(true);
  });

  it('creates stable distinct ordinals and deterministic synthetic receipts', () => {
    const body = stableChannelOutboxOrdinal('request-1:text');
    const attachment = stableChannelOutboxOrdinal('request-1:image:0');
    expect(body).toBe(stableChannelOutboxOrdinal('request-1:text'));
    expect(body).not.toBe(attachment);
    expect(body).toBeGreaterThan(0);

    const ack = syntheticChannelProviderAck({
      turnRunId: 'turn-a',
      ordinal: body,
      payloadHash: 'abc',
    });
    expect(ack).toBe(
      syntheticChannelProviderAck({
        turnRunId: 'turn-a',
        ordinal: body,
        payloadHash: 'abc',
      }),
    );
  });

  it('derives delivery identity from route and payload rather than request id', () => {
    const first = semanticChannelOutboxIdentity({
      route: base,
      kind: 'file',
      payload: { fileName: 'bill.pdf', contentHash: 'content-a' },
    });
    const retriedWithNewRequest = semanticChannelOutboxIdentity({
      route: base,
      kind: 'file',
      payload: { contentHash: 'content-a', fileName: 'bill.pdf' },
    });
    const differentFile = semanticChannelOutboxIdentity({
      route: base,
      kind: 'file',
      payload: { fileName: 'other.pdf', contentHash: 'content-b' },
    });

    expect(retriedWithNewRequest).toBe(first);
    expect(differentFile).not.toBe(first);
    expect(
      semanticChannelOutboxIdentity({
        route: base,
        kind: 'file',
        payload: { fileName: 'bill.pdf', contentHash: 'content-a' },
        ordinalSlot: 'intentional-copy-2',
      }),
    ).not.toBe(first);
  });
});
