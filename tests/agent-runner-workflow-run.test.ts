import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  workflowRunFromOutputFile,
  workflowRunFromTaskProgress,
  workflowRunFromToolInput,
} from '../container/agent-runner/src/workflow-run.js';

const SCRIPT = `
export const meta = {
  name: 'test-demo',
  description: '并行生成三段内容并汇总',
  phases: [
    { title: '生成' },
    { title: '汇总', detail: '整理最终报告' },
  ],
}

const TOPICS = [
  { key: 'motto', prompt: '生成一句格言' },
  { key: 'fact', prompt: '生成一个冷知识' },
  { key: 'micro', prompt: '生成一段微小说' },
]

phase('生成')
const pieces = await parallel(TOPICS.map(t => () =>
  agent(t.prompt, { label: \`gen:\${t.key}\`, phase: '生成' })
))

phase('汇总')
const summary = await agent('汇总素材', { label: '汇总', phase: '汇总' })
return { pieces, summary }
`;

describe('Workflow live projection', () => {
  test('expands title-only phases and mapped template labels', () => {
    const run = workflowRunFromToolInput('workflow-tool', { script: SCRIPT });

    expect(run.workflowName).toBe('test-demo');
    expect(run.phases.map((phase) => phase.title)).toEqual(['生成', '汇总']);
    expect(run.phases[1]?.detail).toBe('整理最终报告');
    expect(run.agents.map((agent) => agent.label)).toEqual([
      'gen:motto',
      'gen:fact',
      'gen:micro',
      '汇总',
    ]);
    expect(run.agents.some((agent) => agent.label.includes('${'))).toBe(false);
    expect(run.agentCount).toBe(4);
  });

  test('maps cumulative SDK progress to the real Agent row', () => {
    const initial = workflowRunFromToolInput('workflow-tool', {
      script: SCRIPT,
    });
    const mottoDone = workflowRunFromTaskProgress(initial, {
      label: 'gen:motto',
      usage: { total_tokens: 37_156, tool_uses: 1, duration_ms: 30_203 },
    });
    const factDone = workflowRunFromTaskProgress(mottoDone, {
      label: 'gen:fact',
      usage: { total_tokens: 74_480, tool_uses: 2, duration_ms: 32_799 },
    });

    expect(
      factDone.agents.find((agent) => agent.label === 'gen:motto'),
    ).toMatchObject({
      state: 'done',
      tokens: 37_156,
    });
    expect(
      factDone.agents.find((agent) => agent.label === 'gen:fact'),
    ).toMatchObject({
      state: 'done',
      tokens: 37_324,
    });
    expect(
      factDone.agents.find((agent) => agent.label === 'gen:micro')?.state,
    ).toBe('queued');
    expect(factDone.totalTokens).toBe(74_480);
  });

  test('uses the SDK output file as the authoritative completed state', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-workflow-'),
    );
    const outputFile = path.join(tempDir, 'workflow.output');
    fs.writeFileSync(
      outputFile,
      JSON.stringify({
        summary: '并行生成三段内容并汇总',
        workflowName: 'test-demo',
        agentCount: 1,
        durationMs: 12_000,
        totalTokens: 321,
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: '生成' },
          {
            type: 'workflow_agent',
            index: 1,
            label: 'gen:motto',
            phaseIndex: 1,
            phaseTitle: '生成',
            state: 'done',
            tokens: 321,
          },
        ],
      }),
    );

    try {
      const run = workflowRunFromOutputFile({
        taskId: 'workflow-tool',
        outputFile,
        status: 'completed',
      });
      expect(run).toMatchObject({
        status: 'completed',
        agentCount: 1,
        totalTokens: 321,
      });
      expect(run?.agents[0]).toMatchObject({
        label: 'gen:motto',
        state: 'done',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
