import { describe, expect, test, vi } from 'vitest';

import {
  resolveIpcDeliveryTargetGroup,
  resolveIpcImRoute,
} from '../src/ipc-delivery-routing.js';
import type { RegisteredGroup } from '../src/types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'target',
    folder: 'flow-x',
    added_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('IPC delivery target authorization lookup', () => {
  test('uses the stable Feishu conversation JID for a native topic route', () => {
    const baseJid = 'feishu:oc_topic_group';
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === baseJid ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup(
        `${baseJid}#thread:omt_topic#root:om_root`,
        lookup,
      ),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith(baseJid);
  });

  test('preserves the channel account scope while removing route fragments', () => {
    const baseJid = 'feishu:oc_topic_group#account:bot-a';
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === baseJid ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup(
        'feishu:oc_topic_group#account:bot-a#thread:omt_topic#root:om_root',
        lookup,
      ),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith(baseJid);
  });

  test('removes a virtual Agent suffix from a Web conversation lookup', () => {
    const target = makeGroup();
    const lookup = vi.fn((jid: string) =>
      jid === 'web:workspace' ? target : undefined,
    );

    expect(
      resolveIpcDeliveryTargetGroup('web:workspace#agent:agent-a', lookup),
    ).toBe(target);
    expect(lookup).toHaveBeenCalledWith('web:workspace');
  });
});

describe('IPC live IM reply route resolution', () => {
  test('conversation Agent looks up the route by its canonical Web virtual JID', () => {
    const currentTopic = 'feishu:oc_topic_group#thread:omt_topic#root:om_root';
    const getActiveRoute = vi.fn((runtimeJid: string) =>
      runtimeJid === 'web:workspace#agent:agent-a' ? currentTopic : null,
    );

    expect(
      resolveIpcImRoute({
        ipcAgentId: 'agent-a',
        isHome: false,
        chatJid: currentTopic,
        sourceGroup: 'flow-x',
        getActiveRoute,
        getAgentChatJid: () => 'web:workspace',
        isImJid: () => true,
      }),
    ).toBe(currentTopic);
    expect(getActiveRoute).toHaveBeenCalledWith('web:workspace#agent:agent-a');
    expect(getActiveRoute).not.toHaveBeenCalledWith(
      `${currentTopic}#agent:agent-a`,
    );
  });

  test('conversation Agent fails closed when its canonical chat is unavailable', () => {
    expect(
      resolveIpcImRoute({
        ipcAgentId: 'missing-agent',
        isHome: false,
        chatJid: 'feishu:oc_topic_group#thread:omt_topic#root:om_root',
        sourceGroup: 'flow-x',
        getActiveRoute: () => 'feishu:unexpected',
        getAgentChatJid: () => null,
        isImJid: () => true,
      }),
    ).toBeNull();
  });

  test('regular workspace preserves the exact topic route for delivery', () => {
    const currentTopic = 'feishu:oc_topic_group#thread:omt_topic#root:om_root';
    expect(
      resolveIpcImRoute({
        isHome: false,
        chatJid: currentTopic,
        sourceGroup: 'flow-x',
        getActiveRoute: () => null,
        getAgentChatJid: () => null,
        isImJid: () => true,
      }),
    ).toBe(currentTopic);
  });

  test('home workspace prefers its current dynamic route', () => {
    expect(
      resolveIpcImRoute({
        isHome: true,
        chatJid: 'feishu:stale-route',
        sourceGroup: 'main',
        getActiveRoute: (runtimeJid) =>
          runtimeJid === 'main' ? 'feishu:current-route' : null,
        getAgentChatJid: () => null,
        isImJid: () => true,
      }),
    ).toBe('feishu:current-route');
  });
});
