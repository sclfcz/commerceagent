import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import {
  COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT,
  withCommerceAgentSubagentContract,
} from '../container/agent-runner/src/sdk-compat.js';

const runnerRoot = path.resolve('container/agent-runner');
const runnerRequire = createRequire(path.join(runnerRoot, 'package.json'));
const runnerSdkEntry = runnerRequire.resolve('@anthropic-ai/claude-agent-sdk');
const runnerSdk = (await import(
  pathToFileURL(runnerSdkEntry).href
)) as typeof import('@anthropic-ai/claude-agent-sdk');
const runnerClaudeExecutable = path.join(
  runnerRoot,
  'node_modules',
  '.bin',
  'claude',
);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'commerceagent-sdk-contract-'));

const MAIN_ONLY_MARKER = 'COMMERCEAGENT_QA_MAIN_ONLY_MARKER';
const CHILD_AGENT_MARKER = 'COMMERCEAGENT_QA_CHILD_AGENT_MARKER';
const CHILD_SKILL_MARKER = 'COMMERCEAGENT_QA_CHILD_SKILL_MARKER';
const PROJECT_CONTEXT_MARKER = 'COMMERCEAGENT_QA_PROJECT_CLAUDE_MD_MARKER';

type CapturedRequest = {
  system?: unknown;
  messages?: unknown;
  tools?: Array<{ name?: string }>;
};

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function fakeProviderEnv(baseUrl: string): Record<string, string> {
  const env = cleanEnv();
  for (const name of [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'fake-local-contract-token',
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

function systemText(request: CapturedRequest): string {
  if (typeof request.system === 'string') return request.system;
  if (!Array.isArray(request.system)) return '';
  return request.system
    .map((block) =>
      block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
}

function writeEvent(
  response: http.ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startMessage(response: http.ServerResponse, id: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  });
}

function finishMessage(
  response: http.ServerResponse,
  stopReason: 'end_turn' | 'tool_use',
): void {
  writeEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

function sendText(
  response: http.ServerResponse,
  id: string,
  text: string,
): void {
  startMessage(response, id);
  writeEvent(response, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  writeEvent(response, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
  writeEvent(response, 'content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  finishMessage(response, 'end_turn');
}

function sendTask(response: http.ServerResponse, id: string): void {
  startMessage(response, id);
  writeEvent(response, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_commerceagent_contract',
      name: 'Task',
      input: {},
    },
  });
  writeEvent(response, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify({
        description: 'verify delegated contract',
        prompt: 'Reply with CHILD_OK only.',
        subagent_type: 'contract-verifier',
      }),
    },
  });
  writeEvent(response, 'content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });
  finishMessage(response, 'tool_use');
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake Anthropic server did not expose a TCP port');
  }
  return address.port;
}

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('Claude Agent SDK delegated runtime contract', () => {
  test('real SDK/CLI appends the CommerceAgent contract and explicit Skill only to the subagent request', async () => {
    const skillDir = path.join(cwd, '.claude', 'skills', 'qa-child-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: qa-child-skill\ndescription: QA child-only skill\n---\n\n${CHILD_SKILL_MARKER}\n`,
    );
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), PROJECT_CONTEXT_MARKER);

    const requests: CapturedRequest[] = [];
    let requestSequence = 0;
    const server = http.createServer((request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        ) as CapturedRequest;
        requests.push(body);
        requestSequence += 1;
        const system = systemText(body);
        const messages = JSON.stringify(body.messages ?? []);
        if (system.includes(COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT)) {
          sendText(response, `msg_child_${requestSequence}`, 'CHILD_OK');
        } else if (messages.includes('CHILD_OK')) {
          sendText(response, `msg_main_done_${requestSequence}`, 'MAIN_OK');
        } else {
          sendTask(response, `msg_main_task_${requestSequence}`);
        }
      });
    });

    const port = await listen(server);
    try {
      const baseOptions = {
        pathToClaudeCodeExecutable: runnerClaudeExecutable,
        cwd,
        model: 'claude-sonnet-4-5-20250929',
        env: fakeProviderEnv(`http://127.0.0.1:${port}`),
        systemPrompt: MAIN_ONLY_MARKER,
        allowedTools: ['Task'],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'] as const,
        skills: [] as string[],
        agents: {
          'contract-verifier': {
            description: 'Checks the delegated runtime contract.',
            prompt: CHILD_AGENT_MARKER,
            tools: [] as string[],
            skills: ['qa-child-skill'],
            model: 'inherit' as const,
          },
        },
      };
      const sdkOptions = withCommerceAgentSubagentContract(baseOptions, {}).options;
      const conversation = runnerSdk.query({
        prompt:
          'Delegate this check to contract-verifier, then return its result.',
        options: sdkOptions,
      });

      let result = '';
      for await (const message of conversation) {
        if (message.type === 'result' && message.subtype === 'success') {
          result = message.result;
        }
      }

      expect(result).toContain('MAIN_OK');
      const mainRequests = requests.filter((request) =>
        systemText(request).includes(MAIN_ONLY_MARKER),
      );
      const childRequests = requests.filter((request) =>
        systemText(request).includes(COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT),
      );
      expect(mainRequests.length).toBeGreaterThan(0);
      expect(childRequests.length).toBeGreaterThan(0);
      expect(
        childRequests.every(
          (request) => !systemText(request).includes(MAIN_ONLY_MARKER),
        ),
      ).toBe(true);
      expect(JSON.stringify(mainRequests[0])).toContain(PROJECT_CONTEXT_MARKER);
      expect(JSON.stringify(childRequests[0])).toContain(
        PROJECT_CONTEXT_MARKER,
      );
      expect(
        mainRequests.every(
          (request) =>
            !systemText(request).includes(COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT),
        ),
      ).toBe(true);
      expect(systemText(childRequests[0])).toContain(CHILD_AGENT_MARKER);
      expect(JSON.stringify(childRequests[0])).toContain(CHILD_SKILL_MARKER);
      expect(childRequests[0].tools?.some((tool) => tool.name === 'Task')).toBe(
        false,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);
});
