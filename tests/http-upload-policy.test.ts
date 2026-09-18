import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createUploadBodyLimitForTest } from '../src/http-upload-policy.js';

describe('upload body limits', () => {
  test('rejects an oversized Content-Length before invoking the handler', async () => {
    const app = new Hono();
    let invoked = false;
    app.post('/upload', createUploadBodyLimitForTest(8), (c) => {
      invoked = true;
      return c.text('ok');
    });

    const response = await app.request('/upload', {
      method: 'POST',
      headers: { 'content-length': String(300 * 1024) },
      body: 'small',
    });

    expect(response.status).toBe(413);
    expect(invoked).toBe(false);
  });

  test('rejects a streamed body that crosses the limit', async () => {
    const app = new Hono();
    let invoked = false;
    app.post('/upload', createUploadBodyLimitForTest(8), async (c) => {
      invoked = true;
      await c.req.arrayBuffer();
      return c.text('ok');
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(150 * 1024));
        controller.enqueue(new Uint8Array(150 * 1024));
        controller.close();
      },
    });
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const response = await app.request(request);
    expect(response.status).toBe(413);
    expect(invoked).toBe(false);
  });
});
