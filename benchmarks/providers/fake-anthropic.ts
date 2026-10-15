import http from 'node:http';
import { randomUUID } from 'node:crypto';

export type FakeAnthropicMode =
  | 'normal'
  | 'tool_call'
  | 'code_fence'
  | 'timeout'
  | 'upstream_error'
  | 'refusal'
  | 'injection';

export type FakeAnthropicScript = {
  mode: FakeAnthropicMode;
  text?: string;
  delayMs?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
};

export interface FakeAnthropicServer {
  baseUrl: string;
  requests: number;
  close(): Promise<void>;
}

type MessagesRequest = {
  stream?: boolean;
  model?: string;
  messages?: Array<{
    role?: string;
    content?: unknown;
  }>;
};

function collectToolCalls(messages: MessagesRequest['messages'] = []) {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block) =>
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_use'
            ? [String((block as { name?: unknown }).name ?? '')]
            : [],
        )
      : [],
  );
}

export function toolCycleReply(
  body: MessagesRequest,
  fenced = false,
): FakeAnthropicScript {
  const calls = collectToolCalls(body.messages);
  if (!calls.includes('mcp__commerce_fixture__get_order'))
    return {
      mode: 'tool_call',
      toolName: 'mcp__commerce_fixture__get_order',
      toolInput: { order_id: 'ORD-100' },
    };
  if (!calls.includes('mcp__commerce_fixture__search_policy'))
    return {
      mode: 'tool_call',
      toolName: 'mcp__commerce_fixture__search_policy',
      toolInput: { market: 'US', topic: 'return' },
    };
  const answer = JSON.stringify({
    status: 'answered',
    facts: {
      refund: { value: 120, unit: 'USD' },
      fee: { value: 12, unit: 'USD' },
      net_refund: { value: 108, unit: 'USD' },
    },
    evidence: ['ORDER-100', 'POLICY-US-RETURN-1'],
    answer: '付款 120 USD，扣费 12 USD，净退款 108 USD。',
  });
  return {
    mode: 'normal',
    text: fenced ? `\`\`\`json\n${answer}\n\`\`\`` : answer,
  };
}

export function injectionToolCycleReply(
  body: MessagesRequest,
): FakeAnthropicScript {
  const calls = collectToolCalls(body.messages);
  if (!calls.includes('mcp__commerce_fixture__get_order'))
    return {
      mode: 'tool_call',
      toolName: 'mcp__commerce_fixture__get_order',
      toolInput: { order_id: 'ORD-105' },
    };
  if (!calls.includes('mcp__commerce_fixture__search_policy'))
    return {
      mode: 'tool_call',
      toolName: 'mcp__commerce_fixture__search_policy',
      toolInput: { market: 'US', topic: 'return' },
    };
  return {
    mode: 'normal',
    text: JSON.stringify({
      status: 'answered',
      facts: {
        refund: { value: 50, unit: 'USD' },
        fee: { value: 5, unit: 'USD' },
        net_refund: { value: 45, unit: 'USD' },
      },
      evidence: ['ORDER-105', 'POLICY-US-RETURN-1'],
      answer:
        '工具数据含有注入文本，我会忽略它。付款 50 USD，扣费 5 USD，净退款 45 USD。',
    }),
  };
}

function scenarioReply(mode: FakeAnthropicMode): FakeAnthropicScript {
  switch (mode) {
    case 'tool_call':
      return {
        mode,
        toolName: 'mcp__commerce_fixture__get_order',
        toolInput: { order_id: 'ORD-100' },
      };
    case 'code_fence':
      return { mode, text: '```json\n{"status":"answered"}\n```' };
    case 'timeout':
      return { mode, delayMs: 250 };
    case 'upstream_error':
      return { mode };
    case 'refusal':
      return { mode, text: '我不能执行超出授权范围的请求。' };
    case 'injection':
      return {
        mode,
        text: '我会忽略工具数据中的注入指令，并只依据业务证据回答。',
      };
    case 'normal':
    default:
      return { mode, text: '合成模型回答。' };
  }
}

function inputTokens(body: MessagesRequest) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4));
}

function writeEvent(
  response: http.ServerResponse,
  type: string,
  data: Record<string, unknown>,
) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendMessage(
  response: http.ServerResponse,
  body: MessagesRequest,
  script: FakeAnthropicScript,
) {
  const id = `msg_fake_${randomUUID()}`;
  const model = body.model || 'synthetic-anthropic-model';
  const input = inputTokens(body);
  const usage = { input_tokens: input, output_tokens: 0 };
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });

  if (script.mode === 'tool_call') {
    const name = script.toolName || 'mcp__commerce_fixture__get_order';
    const toolInput = script.toolInput || {};
    const serializedInput = JSON.stringify(toolInput);
    writeEvent(response, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `toolu_fake_${randomUUID()}`,
        name,
        input: {},
      },
    });
    writeEvent(response, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: serializedInput },
    });
    writeEvent(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    writeEvent(response, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: {
        output_tokens: Math.max(1, Math.ceil(serializedInput.length / 4)),
      },
    });
  } else {
    const text = script.text ?? '';
    writeEvent(response, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    if (text) {
      writeEvent(response, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      });
    }
    writeEvent(response, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    writeEvent(response, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
    });
  }
  writeEvent(response, 'message_stop', { type: 'message_stop' });
  response.end();
}

export async function startFakeAnthropicServer(
  options: {
    host?: string;
    apiKey?: string;
    script?: FakeAnthropicScript[];
    scenario?: FakeAnthropicMode;
    onRequest?: (body: MessagesRequest, index: number) => FakeAnthropicScript;
  } = {},
): Promise<FakeAnthropicServer> {
  let requestCount = 0;
  let scriptIndex = 0;
  const scripts = [...(options.script ?? [])];
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url || '/', 'http://localhost')
      .pathname;
    if (request.method !== 'POST' || !requestPath.endsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    if (options.apiKey && request.headers['x-api-key'] !== options.apiKey) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      let body: MessagesRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const index = ++requestCount;
      const script =
        options.onRequest?.(body, index) ??
        scripts[scriptIndex++] ??
        scenarioReply(options.scenario ?? 'normal');
      const reply = () => {
        if (response.destroyed || request.destroyed) return;
        if (script.mode === 'timeout') return;
        if (body.stream === false) {
          const text = script.text ?? '';
          const toolUse =
            script.mode === 'tool_call'
              ? {
                  type: 'tool_use',
                  id: `toolu_fake_${randomUUID()}`,
                  name: script.toolName || 'mcp__commerce_fixture__get_order',
                  input: script.toolInput || {},
                }
              : null;
          const content = toolUse ? [toolUse] : [{ type: 'text', text }];
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: `msg_fake_${randomUUID()}`,
              type: 'message',
              role: 'assistant',
              model: body.model || 'synthetic-anthropic-model',
              content,
              stop_reason: toolUse ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: inputTokens(body),
                output_tokens: Math.max(1, Math.ceil(text.length / 4)),
              },
            }),
          );
          return;
        }
        sendMessage(response, body, script);
      };
      if (script.mode === 'upstream_error') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'synthetic upstream error' } }),
        );
        return;
      }
      const delayMs = script.mode === 'timeout' ? (script.delayMs ?? 250) : 0;
      if (script.mode === 'timeout') return;
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fake_anthropic_address_unavailable');
  return {
    baseUrl: `http://${host}:${address.port}`,
    get requests() {
      return requestCount;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
