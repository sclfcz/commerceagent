function buildReplyParts(
  partialText: string,
  thinkingText?: string,
  thinkingSummary = '💭 Reasoning',
): string[] {
  const trimmed = partialText.trimEnd();
  const trimmedThinking = thinkingText?.trimEnd();
  const parts: string[] = [];
  if (trimmedThinking) {
    parts.push(
      `<details>\n<summary>${thinkingSummary}</summary>\n\n${trimmedThinking}\n\n</details>`,
    );
  }
  if (trimmed) parts.push(trimmed);
  return parts;
}

/**
 * A real abnormal interruption. Keep the warning treatment for crash/shutdown
 * recovery where the run did not end through an intentional user action.
 */
export function buildInterruptedReply(
  partialText: string,
  thinkingText?: string,
): string {
  const parts = buildReplyParts(
    partialText,
    thinkingText,
    '💭 Reasoning (已中断)',
  );
  parts.push('---\n*⚠️ 已中断*');
  return parts.join('\n\n');
}

/** A user explicitly pressed Stop. This is a normal, neutral terminal state. */
export function buildStoppedReply(
  partialText: string,
  thinkingText?: string,
): string {
  // The timeline already receives one compact `query_interrupted` divider.
  // Persist only useful output generated before Stop; a marker-only assistant
  // bubble would present the same terminal state twice.
  return buildReplyParts(partialText, thinkingText).join('\n\n');
}

/**
 * A follow-up steered the active run. Codex treats this as a direction change,
 * not a failure, so preserve only the useful visible output with no marker.
 */
export function buildSteeredReply(partialText: string): string {
  return partialText.trimEnd();
}

/**
 * A Workflow completion card already communicates that work finished. Remove
 * the model's redundant bridge paragraph when it is immediately followed by
 * the actual Markdown report.
 */
export function stripRedundantCompletionPreamble(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.replace(
    /^(?:(?:分析|任务|工作流|处理).{0,24}完成|已完成)[^\n]{0,240}\s*\n\n---\s*\n\n(?=#\s)/u,
    '',
  );
}
