import { describe, expect, it } from 'vitest';

import {
  ActiveChannelTurnRegistry,
  channelTurnScope,
} from '../src/channel-turn-registry.js';
import type { ChannelTurnContext } from '../src/types.js';

const feishuContext: ChannelTurnContext = {
  schemaVersion: 1,
  provider: 'feishu',
  channelAccountId: 'bot-a',
  sourceJid: 'feishu:oc_chat#account:bot-a',
  chat: { id: 'oc_chat' },
  message: { id: 'om_1' },
};

describe('ActiveChannelTurnRegistry', () => {
  it('separates main and conversation-agent scopes', () => {
    const registry = new ActiveChannelTurnRegistry();
    registry.set(channelTurnScope('home'), {
      correlationId: 'turn-main',
      sourceJid: feishuContext.sourceJid,
      context: feishuContext,
    });
    registry.set(channelTurnScope('home', 'agent-a'), {
      correlationId: 'turn-agent',
      sourceJid: feishuContext.sourceJid,
      context: feishuContext,
    });

    expect(registry.require('home', 'turn-main').correlationId).toBe(
      'turn-main',
    );
    expect(
      registry.require(channelTurnScope('home', 'agent-a'), 'turn-agent')
        .correlationId,
    ).toBe('turn-agent');
  });

  it('rejects stale correlation ids and non-Feishu turns', () => {
    const registry = new ActiveChannelTurnRegistry();
    registry.set('scope', {
      correlationId: 'new-turn',
      sourceJid: feishuContext.sourceJid,
      context: feishuContext,
    });
    expect(() => registry.require('scope', 'old-turn')).toThrow(
      'active input turn',
    );

    registry.set('scope', {
      correlationId: 'web-turn',
      sourceJid: 'web:home',
      context: {
        ...feishuContext,
        provider: 'web',
        sourceJid: 'web:home',
      },
    });
    expect(() => registry.require('scope', 'web-turn')).toThrow(
      'not a Feishu turn',
    );
  });

  it('removes capability when the active turn ends', () => {
    const registry = new ActiveChannelTurnRegistry();
    registry.set('scope', {
      correlationId: 'turn',
      sourceJid: feishuContext.sourceJid,
      context: feishuContext,
    });
    registry.delete('scope');
    expect(() => registry.require('scope', 'turn')).toThrow();
  });
});
