#!/usr/bin/env node
/**
 * Mock external messaging service for the durable-step protocol.
 *
 * It is intentionally dumb: it stores requests in memory and can be told to
 *   - ignore idempotency keys (HONOR_IDEMPOTENCY=false) -> every POST creates a
 *     new message, so duplicates are only prevented by our own reconciliation;
 *   - drop the response after storing the message (DROP_RESPONSE_RATE) -> the
 *     "sent but receipt lost" case;
 *   - fail with 503 (ERROR_RATE) without storing anything;
 *   - hide the lookup endpoint (LOOKUP=false) -> provider cannot reconcile.
 *
 * Runnable: `node scripts/mock-effect-provider.mjs` (PORT, ... env vars).
 * Importable: `const mock = await startMockProvider({...})`.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startMockProvider(options = {}) {
  const state = {
    honorIdempotency: options.honorIdempotency ?? true,
    lookup: options.lookup ?? true,
    dropResponseRate: options.dropResponseRate ?? 0,
    errorRate: options.errorRate ?? 0,
    latencyMs: options.latencyMs ?? 0,
    receivedRequests: 0,
    deliveredMessages: 0,
    duplicateDeliveries: 0,
    messages: new Map(), // idempotencyKey -> message
    sequence: 0,
    deadSockets: 0,
  };

  const random = () => Math.random();
  const delay = () =>
    state.latencyMs > 0
      ? new Promise((resolve) =>
          setTimeout(resolve, Math.floor(random() * state.latencyMs)),
        )
      : Promise.resolve();

  const send = async (req, res) => {
    state.receivedRequests += 1;
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = { raw: body };
    }
    await delay();

    if (state.errorRate > 0 && random() < state.errorRate) {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unavailable' }));
      return;
    }

    const key = String(req.headers['idempotency-key'] ?? '');
    if (!key) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'missing_idempotency_key' }));
      return;
    }

    let message = state.messages.get(key);
    if (!message) {
      state.sequence += 1;
      message = {
        message_id: `msg-${state.sequence}`,
        idempotency_key: key,
        request: parsed,
        created_at: new Date().toISOString(),
      };
      state.messages.set(key, message);
      state.deliveredMessages += 1;
    } else if (state.honorIdempotency) {
      // Same key, same message: no new delivery, no duplicate.
    } else {
      // Provider ignores the key: a new message is created every time.
      state.sequence += 1;
      state.deliveredMessages += 1;
      state.duplicateDeliveries += 1;
      message = {
        ...message,
        message_id: `msg-${state.sequence}`,
        created_at: new Date().toISOString(),
      };
      state.messages.set(key, message);
    }

    if (state.dropResponseRate > 0 && random() < state.dropResponseRate) {
      // Stored server-side, but the caller never learns the result.
      state.deadSockets += 1;
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        message_id: message.message_id,
        idempotency_key: key,
      }),
    );
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/messages') {
      await send(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/messages') {
      if (!state.lookup) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'lookup_disabled' }));
        return;
      }
      const key = url.searchParams.get('idempotency_key') ?? '';
      const message = state.messages.get(key);
      if (!message) {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          message_id: message.message_id,
          idempotency_key: key,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          receivedRequests: state.receivedRequests,
          deliveredMessages: state.deliveredMessages,
          duplicateDeliveries: state.duplicateDeliveries,
          uniqueKeys: state.messages.size,
          deadSockets: state.deadSockets,
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/reset') {
      state.receivedRequests = 0;
      state.deliveredMessages = 0;
      state.duplicateDeliveries = 0;
      state.deadSockets = 0;
      state.messages.clear();
      state.sequence = 0;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        get stats() {
          return {
            receivedRequests: state.receivedRequests,
            deliveredMessages: state.deliveredMessages,
            duplicateDeliveries: state.duplicateDeliveries,
            uniqueKeys: state.messages.size,
            deadSockets: state.deadSockets,
          };
        },
        setOptions(patch) {
          Object.assign(state, patch);
        },
        reset() {
          state.receivedRequests = 0;
          state.deliveredMessages = 0;
          state.duplicateDeliveries = 0;
          state.deadSockets = 0;
          state.messages.clear();
          state.sequence = 0;
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const mock = await startMockProvider({
    port: Number(process.env.PORT ?? 8099),
    honorIdempotency: (process.env.HONOR_IDEMPOTENCY ?? 'true') === 'true',
    lookup: (process.env.LOOKUP ?? 'true') === 'true',
    dropResponseRate: Number(process.env.DROP_RESPONSE_RATE ?? 0),
    errorRate: Number(process.env.ERROR_RATE ?? 0),
    latencyMs: Number(process.env.LATENCY_MS ?? 0),
  });
  process.stdout.write(
    JSON.stringify({ event: 'mock_effect_provider_started', url: mock.url }) +
      '\n',
  );
  const shutdown = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
