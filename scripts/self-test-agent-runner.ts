import {
  buildBackgroundTaskSummaryPrompt,
  shouldForceBackgroundTaskSummary,
} from '../container/agent-runner/src/utils.js';

interface SimulatedResult {
  label: string;
  finalText: string;
  pendingBgTasks: number;
}

const incidentReplay: SimulatedResult[] = [
  {
    label: 'initial progress while background agents are still running',
    finalText:
      '6 个 Agent 调研中，结果到齐后我会汇总并撰写飞书文档发你。\n\n> ⏳ 2 个后台任务运行中，完成后将继续汇总',
    pendingBgTasks: 2,
  },
  {
    label: 'stale final-looking wait reply after all background agents settled',
    finalText: '1/6 完成（执行层），已落盘。等待其余 5 个 Agent。',
    pendingBgTasks: 0,
  },
  {
    label: 'healthy final synthesis after forced continuation',
    finalText:
      '调研完成。Matt Pocock v1.1 的当前工作流是 grill-with-docs -> to-spec -> to-tickets -> implement -> code-review。',
    pendingBgTasks: 0,
  },
];

let sawPendingBackgroundTasks = false;
let attempts = 0;
let forced = false;

for (const result of incidentReplay) {
  if (result.pendingBgTasks > 0) {
    sawPendingBackgroundTasks = true;
  }

  const shouldForce = shouldForceBackgroundTaskSummary({
    emitOutput: true,
    sawPendingBackgroundTasks,
    pendingBgTasks: result.pendingBgTasks,
    finalText: result.finalText,
    attempts,
    maxAttempts: 2,
  });

  if (shouldForce) {
    attempts += 1;
    forced = true;
    const prompt = buildBackgroundTaskSummaryPrompt();
    if (!prompt.includes('Do not send another progress update')) {
      throw new Error(
        'Forced continuation prompt is missing the anti-progress-update instruction',
      );
    }
    continue;
  }

  if (result.pendingBgTasks === 0) {
    sawPendingBackgroundTasks = false;
    attempts = 0;
  }
}

if (!forced) {
  throw new Error('Incident replay did not force a final-summary continuation');
}

console.log(
  'agent-runner self-test passed: stale background-task wait reply is suppressed and continued',
);
