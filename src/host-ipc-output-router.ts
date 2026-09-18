import { channelTurnScope } from './channel-turn-registry.js';
import {
  ActiveTurnOutputRegistry,
  type StageTurnMessageResult,
  type TurnMessageDeliveryRole,
} from './turn-output-coordinator.js';

export interface HostIpcOutputRouteInput {
  sourceGroup: string;
  agentId?: string | null;
  inputTurnId?: unknown;
  text: string;
  deliveryRole?: unknown;
  authorized: boolean;
  scheduledTask: boolean;
  interactionMode?: 'assistant' | 'proactive';
}

/**
 * Resolve the logical chat JID an IPC output should be persisted and broadcast
 * under.
 *
 * `sourceChatJid` is the runner's `channelContext.sourceJid`, i.e. the raw IM
 * JID (`qq:c2c:...`). Inbound routing already folds that JID to the bound
 * workspace before the turn runs, so without the symmetric fold here a
 * proactive `send_message` would be stored against the IM row — whose
 * `folder`/`created_by` still belong to the channel account owner, not to the
 * workspace that produced the reply. `resolveWorkspaceJid` supplies that fold;
 * when it is absent or returns null the raw JID is kept, preserving behaviour
 * for unbound chats.
 */
export function resolveHostIpcLogicalChatJid(input: {
  sourceChatJid: string;
  agentId?: string | null;
  agentChatJid?: string | null;
  taskRunId?: string | null;
  scheduledTask: boolean;
  /** Immutable logical base captured when the input turn was admitted. */
  runtimeChatJid?: string | null;
  resolveWorkspaceJid?: (chatJid: string) => string | null;
}): string {
  const baseChatJid =
    input.runtimeChatJid ||
    input.resolveWorkspaceJid?.(input.sourceChatJid) ||
    input.sourceChatJid;
  if (input.agentId) {
    return `${input.agentChatJid || baseChatJid}#agent:${input.agentId}`;
  }
  if (input.taskRunId && input.scheduledTask) {
    return `${baseChatJid}#task:${input.taskRunId}`;
  }
  return baseChatJid;
}

export type HostIpcOutputRoute =
  | {
      path: 'primary_projection';
      delivered: boolean;
      staged: boolean;
      disposition?: 'staged_progress' | 'staged_final';
      deliveryRole: 'progress' | 'final';
      stageResult: StageTurnMessageResult;
    }
  | {
      path: 'separate_provider';
      delivered: false;
      staged: false;
      deliveryRole: TurnMessageDeliveryRole | null;
      attemptedFinalRecorded: boolean;
    }
  | {
      path: 'rejected';
      delivered: false;
      staged: false;
      deliveryRole: TurnMessageDeliveryRole | null;
    };

function normalizeDeliveryRole(value: unknown): TurnMessageDeliveryRole | null {
  return value === 'progress' || value === 'final' || value === 'separate'
    ? value
    : null;
}

/**
 * Selects the host-side delivery lane for one send_message IPC request.
 *
 * An explicit progress/final request is consumed by the exact active primary
 * turn, including conversation agents. Even a failed stage attempt is still
 * consumed so it cannot fall through and create a second provider message.
 * Legacy requests, explicit `separate`, and scheduled-task notifications keep
 * their independent delivery path.
 */
export function routeHostIpcOutput(
  input: HostIpcOutputRouteInput,
  activeTurnOutputs: ActiveTurnOutputRegistry,
): HostIpcOutputRoute {
  const deliveryRole = normalizeDeliveryRole(input.deliveryRole);
  if (!input.authorized) {
    return {
      path: 'rejected',
      delivered: false,
      staged: false,
      deliveryRole,
    };
  }
  if (
    input.scheduledTask ||
    deliveryRole === null ||
    deliveryRole === 'separate'
  ) {
    return {
      path: 'separate_provider',
      delivered: false,
      staged: false,
      deliveryRole,
      attemptedFinalRecorded: false,
    };
  }

  if (input.interactionMode === 'proactive') {
    const attemptedFinalRecorded =
      deliveryRole === 'final' &&
      typeof input.inputTurnId === 'string' &&
      Boolean(input.inputTurnId) &&
      activeTurnOutputs.recordAttemptedFinal({
        scopeKey: channelTurnScope(input.sourceGroup, input.agentId),
        inputTurnId: input.inputTurnId,
        text: input.text,
      });
    return {
      path: 'separate_provider',
      delivered: false,
      staged: false,
      deliveryRole,
      attemptedFinalRecorded,
    };
  }

  const stageResult =
    typeof input.inputTurnId === 'string' && input.inputTurnId
      ? activeTurnOutputs.stage({
          scopeKey: channelTurnScope(input.sourceGroup, input.agentId),
          inputTurnId: input.inputTurnId,
          role: deliveryRole,
          text: input.text,
        })
      : {
          accepted: false,
          duplicate: false,
          reason: 'inactive_turn' as const,
        };

  return {
    path: 'primary_projection',
    delivered: stageResult.accepted,
    staged: stageResult.accepted,
    disposition: stageResult.accepted
      ? deliveryRole === 'progress'
        ? 'staged_progress'
        : 'staged_final'
      : undefined,
    deliveryRole,
    stageResult,
  };
}
