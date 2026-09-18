import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import {
  attachSessionWorkflowRuns,
  normalizeWorkflowRun,
} from '../src/session-workflows.js';

const createdGroups: string[] = [];

afterEach(() => {
  for (const group of createdGroups.splice(0)) {
    fs.rmSync(path.join(DATA_DIR, 'sessions', group), {
      recursive: true,
      force: true,
    });
  }
});

function completedWorkflow() {
  return {
    taskId: 'ws4k8unmd',
    runId: 'wf_b870d806-6c4',
    workflowName: 'analyze-github-user',
    summary: '分析 GitHub 用户 riba2534 最近的活跃情况',
    status: 'completed',
    startTime: Date.parse('2026-07-21T06:30:23.529Z'),
    timestamp: '2026-07-21T06:37:30.251Z',
    durationMs: 426_722,
    agentCount: 5,
    totalTokens: 251_749,
    totalToolCalls: 20,
    phases: [
      { title: 'Fetch', detail: '并行抓取四个数据维度' },
      { title: 'Synthesize', detail: '跨维度关联分析' },
    ],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Fetch' },
      { type: 'workflow_phase', index: 2, title: 'Synthesize' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'profile',
        phaseIndex: 1,
        phaseTitle: 'Fetch',
        agentId: 'a-profile',
        model: 'glm-5.2[1m]',
        state: 'done',
        tokens: 41_210,
        toolCalls: 4,
        durationMs: 98_000,
      },
      {
        type: 'workflow_agent',
        index: 5,
        label: 'synthesize',
        phaseIndex: 2,
        phaseTitle: 'Synthesize',
        agentId: 'a-synthesize',
        model: 'glm-5.2[1m]',
        state: 'done',
        tokens: 57_169,
        toolCalls: 0,
        durationMs: 131_063,
      },
    ],
  };
}

describe('Claude Code Workflow session projection', () => {
  test('normalizes phases, agents and authoritative totals', () => {
    const run = normalizeWorkflowRun(completedWorkflow());

    expect(run).toMatchObject({
      taskId: 'ws4k8unmd',
      runId: 'wf_b870d806-6c4',
      status: 'completed',
      agentCount: 5,
      totalTokens: 251_749,
      totalToolCalls: 20,
      durationMs: 426_722,
    });
    expect(run?.phases).toEqual([
      { index: 1, title: 'Fetch', detail: '并行抓取四个数据维度' },
      { index: 2, title: 'Synthesize', detail: '跨维度关联分析' },
    ]);
    expect(run?.agents[1]).toMatchObject({
      label: 'synthesize',
      phaseIndex: 2,
      state: 'done',
      tokens: 57_169,
    });
  });

  test('attaches a completed workflow only to the final assistant message', () => {
    const group = `workflow-test-${process.pid}-${Date.now()}`;
    createdGroups.push(group);
    const sessionId = 'session-1';
    const workflowDir = path.join(
      DATA_DIR,
      'sessions',
      group,
      '.claude',
      'projects',
      `-${os.platform()}-fixture`,
      sessionId,
      'workflows',
    );
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, 'wf_fixture.json'),
      JSON.stringify(completedWorkflow()),
    );
    fs.writeFileSync(
      path.join(workflowDir, '..', '..', `${sessionId}.jsonl`),
      [
        {
          type: 'user',
          uuid: 'user-turn',
          message: { content: '<messages><message>分析</message></messages>' },
        },
        {
          type: 'assistant',
          uuid: 'thinking-sdk',
          message: {
            id: 'assistant-api-call',
            model: 'glm-5.2',
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
            },
            content: [{ type: 'thinking', thinking: '分析中' }],
          },
        },
        {
          type: 'assistant',
          uuid: 'final-sdk',
          message: {
            id: 'assistant-api-call',
            model: 'glm-5.2',
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
            },
            content: [{ type: 'text', text: '最终结果' }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const messages = attachSessionWorkflowRuns(
      [
        {
          id: 'process',
          timestamp: '2026-07-21T06:31:00.000Z',
          session_id: sessionId,
          is_from_me: true,
        },
        {
          id: 'final',
          timestamp: '2026-07-21T06:39:38.000Z',
          session_id: sessionId,
          sdk_message_uuid: 'final-sdk',
          is_from_me: true,
          token_usage: JSON.stringify({
            inputTokens: 0,
            outputTokens: 0,
            durationMs: 296_100,
          }),
        },
      ],
      { groupFolder: group, agentId: null },
    );

    expect(messages[0].workflow_runs).toBeUndefined();
    expect(messages[1].workflow_runs?.[0]).toMatchObject({
      taskId: 'ws4k8unmd',
      totalTokens: 251_749,
    });
    expect(JSON.parse(messages[1].token_usage ?? '{}')).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      durationMs: 296_100,
      modelUsage: {
        'glm-5.2': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
        },
      },
    });

    // Incremental follow-up: an active session keeps appending to the same
    // transcript. A half-written line must stay invisible until completed,
    // then the next pass parses only the appended bytes.
    const transcript = path.join(workflowDir, '..', '..', `${sessionId}.jsonl`);
    const turn2User = JSON.stringify({
      type: 'user',
      uuid: 'user-turn-2',
      message: { content: '<messages><message>继续</message></messages>' },
    });
    const turn2Assistant = JSON.stringify({
      type: 'assistant',
      uuid: 'final-sdk-2',
      message: {
        id: 'assistant-api-call-2',
        model: 'glm-5.2',
        usage: { input_tokens: 7, output_tokens: 5 },
        content: [{ type: 'text', text: '第二轮' }],
      },
    });
    const half = turn2Assistant.slice(0, 40);
    fs.appendFileSync(transcript, `\n${turn2User}\n${half}`);
    const followUpMessage = () => ({
      id: 'final-2',
      timestamp: '2026-07-21T06:59:38.000Z',
      session_id: sessionId,
      sdk_message_uuid: 'final-sdk-2',
      is_from_me: true,
      token_usage: JSON.stringify({ inputTokens: 0, outputTokens: 0 }),
    });
    const midWrite = attachSessionWorkflowRuns([followUpMessage()], {
      groupFolder: group,
      agentId: null,
    });
    expect(JSON.parse(midWrite[0].token_usage ?? '{}').inputTokens ?? 0).toBe(
      0,
    );

    fs.appendFileSync(transcript, turn2Assistant.slice(40));
    const completed = attachSessionWorkflowRuns([followUpMessage()], {
      groupFolder: group,
      agentId: null,
    });
    expect(JSON.parse(completed[0].token_usage ?? '{}')).toMatchObject({
      inputTokens: 7,
      outputTokens: 5,
    });
  });
});
