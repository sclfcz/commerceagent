import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Agent Runner reply-mode prompt contract', () => {
  test('injects one explicit contract into every public interactive Agent', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const start = runner.indexOf('...(!containerInput.isScheduledTask');
    const end = runner.indexOf('});', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const selection = runner.slice(start, end);
    expect(selection).toContain('!containerInput.messageTaskId');
    expect(selection).toContain('proactiveInteractiveContract');
    expect(selection).toContain('PROACTIVE_DELIVERY_CONTRACT');
    expect(selection).toContain('ASSISTANT_DELIVERY_CONTRACT');
    expect(selection).not.toContain('containerInput.agentId');
    expect(runner).toContain("containerInput.interactionMode === 'proactive'");
  });

  test('aligns system guidance, tool behavior, and host projection semantics', () => {
    const assistant = read(
      'container/agent-runner/prompts/delivery-contract.assistant.md',
    );
    const proactive = read(
      'container/agent-runner/prompts/delivery-contract.proactive.md',
    );
    const tools = read('container/agent-runner/src/mcp-tools.ts');
    const runner = read('container/agent-runner/src/index.ts');
    const proactiveOutput = read(
      'container/agent-runner/prompts/output.proactive.md',
    );
    const hostPolicy = read('src/workspace-interaction-runtime.ts');

    expect(assistant).toContain('automatically publishes');
    expect(proactive).toContain(
      '`mcp__commerceagent__send_message` is the only way',
    );
    // The tool descriptions must gate on the same three conditions as the
    // prompt selector in the runner, including `currentTaskId`: a
    // message-triggered task run takes the task contract, not the interactive
    // Proactive one. Asserting the named predicate rather than an inline
    // expression keeps the two sides from drifting apart again.
    expect(tools).toContain('const usesProactiveInteractiveContract =');
    expect(tools).toContain("ctx.interactionMode === 'proactive' &&");
    expect(tools).toContain('!ctx.isScheduledTask &&');
    expect(tools).toContain('!ctx.currentTaskId');
    expect(tools).toContain("presentation: 'native'");
    expect(runner).toContain('!proactiveInteractiveContract &&');
    expect(runner).toContain(
      'result: proactiveInteractiveContract ? null : candidate.finalText',
    );
    expect(runner).toContain('proactiveFinalCandidate: candidate.finalText');
    expect(proactive).toContain('`delivery_role=progress`');
    expect(proactive).toContain('`delivery_role=final`');
    expect(proactive).toContain('Never label a complete answer as `progress`');
    expect(tools).toContain("? (args.delivery_role ?? 'progress')");
    expect(tools).toContain('This does not complete the user-visible answer');
    expect(proactiveOutput).not.toContain('最终回复必须自包含');
    expect(proactiveOutput).toContain(
      '[Your previous response had no visible output.',
    );
    expect(proactiveOutput).toContain('在第一个可能明显耗时的工具调用前');
    expect(proactiveOutput).toContain('简单问题直接回答');
    expect(proactive).not.toContain('minimal internal acknowledgement');
    expect(proactive).toContain('SDK-final acknowledgement');
    expect(proactive).toContain('Assistant text is never a delivery fallback');
    expect(proactiveOutput).toContain(
      '普通 Assistant 文本绝不是发送失败时的备用回复',
    );
    expect(hostPolicy).toContain("return mode === 'assistant';");
    expect(hostPolicy).toContain("return mode === 'proactive';");
  });
});
