import type { Message } from '../stores/chat';

const LEGACY_INTERRUPTED_SUFFIX = /\n\n---\n\*⚠️ 已中断\*\s*$/;
const LEGACY_STOPPED_SUFFIX = /(?:^|\n\n)---\n\*已停止\*\s*$/;
const LEGACY_HELD_PREFIX =
  /^[\s\S]*?>\s*⏳\s*\d+\s*个后台任务运行中，完成后将继续汇总\s*\n\n---\s*\n\n/u;
const REDUNDANT_COMPLETION_PREAMBLE =
  /^(?:(?:分析|任务|工作流|处理).{0,24}完成|已完成)[^\n]{0,240}\s*\n\n---\s*\n\n(?=#\s)/u;
const BACKGROUND_RUNNING_MARKER =
  />\s*⏳\s*\d+\s*个后台任务运行中，完成后将继续汇总\s*$/u;

/** The live Workflow card replaces this temporary prose acknowledgement. */
export function isHeldBackgroundAcknowledgement(content: string): boolean {
  return BACKGROUND_RUNNING_MARKER.test(content.trimEnd());
}

/**
 * Older intentional stops and steers were persisted with a warning footer.
 * Present those normal user-directed transitions without failure styling,
 * while retaining warnings for genuine error/crash recovery rows.
 */
export function getPresentedMessageContent(
  message: Pick<Message, 'content' | 'source_kind' | 'finalization_reason'>,
): string {
  const cleanCompletedContent = (content: string) =>
    content
      .replace(LEGACY_HELD_PREFIX, '')
      .replace(REDUNDANT_COMPLETION_PREAMBLE, '');
  if (
    message.source_kind !== 'interrupt_partial' ||
    message.finalization_reason !== 'interrupted'
  ) {
    return cleanCompletedContent(message.content);
  }

  return message.content
    .replace(
      '<summary>💭 Reasoning (已中断)</summary>',
      '<summary>💭 Reasoning</summary>',
    )
    .replace(LEGACY_INTERRUPTED_SUFFIX, '')
    .replace(LEGACY_STOPPED_SUFFIX, '')
    .trimEnd();
}
