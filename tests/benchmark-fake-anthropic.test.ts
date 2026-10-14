import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeAnthropicServer,
  type FakeAnthropicMode,
} from '../benchmarks/providers/fake-anthropic.js';

const servers: Array<Awaited<ReturnType<typeof startFakeAnthropicServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function invokeScenario(mode: FakeAnthropicMode) {
  const server = await startFakeAnthropicServer({
    scenario: mode,
    apiKey: 'selftest-only-key',
  });
  servers.push(server);
  const response = await fetch(`${server.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'selftest-only-key',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'synthetic-model',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'synthetic request' }],
    }),
  });
  return { response, body: await response.text(), server };
}

describe('offline Anthropic Messages fake service', () => {
  it('scripts normal text, code fencing, refusal and injection-safe responses', async () => {
    const normal = await invokeScenario('normal');
    expect(normal.response.status).toBe(200);
    expect(normal.body).toContain('message_start');
    expect(normal.body).toContain('合成模型回答');

    const fenced = await invokeScenario('code_fence');
    expect(fenced.body).toContain('```json');

    const refused = await invokeScenario('refusal');
    expect(refused.body).toContain('我不能执行超出授权范围');

    const injection = await invokeScenario('injection');
    expect(injection.body).toContain('忽略工具数据中的注入指令');
    expect(injection.body).not.toContain('EVAL_COMPROMISED');
  });

  it('emits an Anthropic tool_use block and leaves timeout connections open', async () => {
    const tool = await invokeScenario('tool_call');
    expect(tool.body).toContain('"type":"tool_use"');
    expect(tool.body).toContain('mcp__commerce_fixture__get_order');
    expect(tool.body).toContain('input_json_delta');

    const timeoutServer = await startFakeAnthropicServer({
      scenario: 'timeout',
      apiKey: 'selftest-only-key',
    });
    servers.push(timeoutServer);
    await expect(
      fetch(`${timeoutServer.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'selftest-only-key',
        },
        body: JSON.stringify({
          model: 'synthetic-model',
          max_tokens: 10,
          stream: true,
          messages: [],
        }),
        signal: AbortSignal.timeout(40),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('rejects calls without the synthetic test credential', async () => {
    const server = await startFakeAnthropicServer({
      scenario: 'normal',
      apiKey: 'selftest-only-key',
    });
    servers.push(server);
    const response = await fetch(`${server.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model', messages: [] }),
    });
    expect(response.status).toBe(401);
  });
});
