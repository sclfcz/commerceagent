import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { channelTurnScope } from '../src/channel-turn-registry.js';
import {
  resolveHostIpcLogicalChatJid,
  routeHostIpcOutput,
} from '../src/host-ipc-output-router.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';

describe('host IPC primary output routing', () => {
  test('projects conversation-agent output into its canonical Web session', () => {
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'feishu:oc_chat#thread:omt_topic#root:om_root',
        agentId: 'conversation-agent',
        agentChatJid: 'web:main',
        scheduledTask: false,
      }),
    ).toBe('web:main#agent:conversation-agent');
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'web:workspace',
        taskRunId: 'task-run-1',
        scheduledTask: true,
      }),
    ).toBe('web:workspace#task:task-run-1');
  });

  test('attributes a bound IM chat output to its workspace, not the IM row', () => {
    // The runner reports channelContext.sourceJid, so without the fold this
    // reply would be stored under the IM row whose folder/created_by still
    // belong to the channel account owner.
    const resolveWorkspaceJid = (chatJid: string) =>
      chatJid === 'qq:c2c:CHAT_A' ? 'web:ws-b' : null;

    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_A',
        scheduledTask: false,
        resolveWorkspaceJid,
      }),
    ).toBe('web:ws-b');
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_A',
        taskRunId: 'task-run-2',
        scheduledTask: true,
        resolveWorkspaceJid,
      }),
    ).toBe('web:ws-b#task:task-run-2');
    // An explicit agent JID still wins over the folded source.
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_A',
        agentId: 'agent-1',
        agentChatJid: 'web:ws-c',
        scheduledTask: false,
        resolveWorkspaceJid,
      }),
    ).toBe('web:ws-c#agent:agent-1');
  });

  test('keeps the raw source JID when the chat has no workspace binding', () => {
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_UNBOUND',
        scheduledTask: false,
        resolveWorkspaceJid: () => null,
      }),
    ).toBe('qq:c2c:CHAT_UNBOUND');
    // No resolver injected at all (legacy call sites) must not change.
    expect(
      resolveHostIpcLogicalChatJid({
        sourceChatJid: 'qq:c2c:CHAT_UNBOUND',
        scheduledTask: false,
      }),
    ).toBe('qq:c2c:CHAT_UNBOUND');
  });

  test('keeps delayed text and image output in the workspace frozen for the turn', () => {
    // The chat was admitted under ws-a, then rebound to ws-b while the model
    // was still working. Both IPC paths call this helper and must prefer the
    // immutable runtime scope over the output-time binding lookup.
    const reboundWorkspace = () => 'web:ws-b';
    const delayedTextJid = resolveHostIpcLogicalChatJid({
      sourceChatJid: 'qq:c2c:CHAT_A',
      scheduledTask: false,
      runtimeChatJid: 'web:ws-a',
      resolveWorkspaceJid: reboundWorkspace,
    });
    const delayedImageJid = resolveHostIpcLogicalChatJid({
      sourceChatJid: 'qq:c2c:CHAT_A',
      scheduledTask: false,
      runtimeChatJid: 'web:ws-a',
      resolveWorkspaceJid: reboundWorkspace,
    });

    expect(delayedTextJid).toBe('web:ws-a');
    expect(delayedImageJid).toBe('web:ws-a');
  });

  test('stages a custom-agent final in its exact scope without a separate provider send', async () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projectedFinal = vi.fn(() => true);
    const sendImWithRetry = vi.fn(async () => true);
    const sourceGroup = 'research-workspace';
    const agentId = 'research-agent';
    activeTurnOutputs.bind(
      channelTurnScope(sourceGroup, agentId),
      'input-turn-7',
      {
        onProgress: () => true,
        onFinalCandidate: projectedFinal,
      },
    );

    const route = routeHostIpcOutput(
      {
        sourceGroup,
        agentId,
        inputTurnId: 'input-turn-7',
        text: '最终调研报告',
        deliveryRole: 'final',
        authorized: true,
        scheduledTask: false,
      },
      activeTurnOutputs,
    );
    if (route.path === 'separate_provider') {
      await sendImWithRetry();
    }

    expect(route).toMatchObject({
      path: 'primary_projection',
      delivered: true,
      staged: true,
      disposition: 'staged_final',
      deliveryRole: 'final',
    });
    expect(projectedFinal).toHaveBeenCalledOnce();
    expect(projectedFinal).toHaveBeenCalledWith('最终调研报告');
    expect(sendImWithRetry).not.toHaveBeenCalled();
  });

  test('consumes a failed primary stage instead of falling through to a sibling message', async () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const sendImWithRetry = vi.fn(async () => true);

    const route = routeHostIpcOutput(
      {
        sourceGroup: 'research-workspace',
        agentId: 'research-agent',
        inputTurnId: 'inactive-turn',
        text: '迟到的答案',
        deliveryRole: 'final',
        authorized: true,
        scheduledTask: false,
      },
      activeTurnOutputs,
    );
    if (route.path === 'separate_provider') {
      await sendImWithRetry();
    }

    expect(route).toMatchObject({
      path: 'primary_projection',
      delivered: false,
      staged: false,
      stageResult: {
        accepted: false,
        reason: 'inactive_turn',
      },
    });
    expect(sendImWithRetry).not.toHaveBeenCalled();
  });

  test('keeps scheduled and explicitly separate output on the provider lane', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();

    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-1',
          text: '定时任务通知',
          deliveryRole: 'final',
          authorized: true,
          scheduledTask: true,
        },
        activeTurnOutputs,
      ).path,
    ).toBe('separate_provider');
    expect(
      routeHostIpcOutput(
        {
          sourceGroup: 'workspace',
          inputTurnId: 'turn-1',
          text: '额外通知',
          deliveryRole: 'separate',
          authorized: true,
          scheduledTask: false,
        },
        activeTurnOutputs,
      ).path,
    ).toBe('separate_provider');
  });

  test('proactive mode forces progress and final requests onto independent message delivery', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const projected = vi.fn(() => true);
    activeTurnOutputs.bind(
      channelTurnScope('workspace', 'conversation-agent'),
      'turn-1',
      {
        onProgress: projected,
        onFinalCandidate: projected,
      },
    );

    for (const deliveryRole of ['progress', 'final'] as const) {
      expect(
        routeHostIpcOutput(
          {
            sourceGroup: 'workspace',
            agentId: 'conversation-agent',
            inputTurnId: 'turn-1',
            text: `${deliveryRole} utterance`,
            deliveryRole,
            authorized: true,
            scheduledTask: false,
            interactionMode: 'proactive',
          },
          activeTurnOutputs,
        ),
      ).toMatchObject({
        path: 'separate_provider',
        staged: false,
        deliveryRole,
      });
    }
    expect(projected).not.toHaveBeenCalled();
  });

  test('records the exact Proactive final before entering provider delivery', () => {
    const activeTurnOutputs = new ActiveTurnOutputRegistry();
    const scope = channelTurnScope('workspace', 'conversation-agent');
    const coordinator = activeTurnOutputs.bind(scope, 'turn-1', {
      onProgress: () => true,
      onFinalCandidate: () => true,
    });

    const route = routeHostIpcOutput(
      {
        sourceGroup: 'workspace',
        agentId: 'conversation-agent',
        inputTurnId: 'turn-1',
        text: '准确的完整总结正文',
        deliveryRole: 'final',
        authorized: true,
        scheduledTask: false,
        interactionMode: 'proactive',
      },
      activeTurnOutputs,
    );

    expect(route).toMatchObject({
      path: 'separate_provider',
      deliveryRole: 'final',
      attemptedFinalRecorded: true,
    });
    expect(coordinator.attemptedFinalText).toBe('准确的完整总结正文');
    expect(
      activeTurnOutputs.recordAttemptedFinal({
        scopeKey: scope,
        inputTurnId: 'turn-1',
        text: '另一个不应替换首个 final 的正文',
      }),
    ).toBe(false);
    expect(coordinator.attemptedFinalText).toBe('准确的完整总结正文');
  });

  test('wires both host execution paths to the live visible answer for interruption persistence', () => {
    const main = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );

    expect(main).toMatch(
      /streamingAccumulatedText\s*=\s*answerProjection\.visibleAnswerText;/,
    );
    expect(main).toMatch(
      /agentStreamingAccText\s*=\s*agentAnswerProjection\.visibleAnswerText;/,
    );
    expect(main).not.toContain(
      'streamingAccumulatedText = answerProjection.answerText;',
    );
    expect(main).not.toContain(
      'agentStreamingAccText = agentAnswerProjection.answerText;',
    );
  });
});
