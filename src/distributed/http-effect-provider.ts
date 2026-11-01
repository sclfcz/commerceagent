import { EffectPermanentError, type EffectProvider } from './durable.js';

export interface HttpEffectProviderOptions {
  /** Base URL of the mock/real messaging service, e.g. http://127.0.0.1:8099 */
  baseUrl: string;
  /** Whether the service exposes GET /messages?idempotency_key=... */
  supportsLookup?: boolean;
  name?: string;
  /** Per-request timeout; the durable context also enforces its own budget. */
  requestTimeoutMs?: number;
}

interface MessageResponse {
  message_id?: string;
  ref?: string;
}

/**
 * `EffectProvider` for a simple HTTP messaging API.
 *
 * - 4xx -> `EffectPermanentError` (do not retry, the run goes dead)
 * - 5xx / network / timeout -> plain Error (the context marks the step unknown
 *   and the next attempt reconciles)
 */
export class HttpEffectProvider implements EffectProvider {
  readonly name: string;
  readonly supportsLookup: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpEffectProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.supportsLookup = options.supportsLookup ?? true;
    this.name = options.name ?? 'http-mock';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  private async request(
    path: string,
    init: RequestInit & { signal?: AbortSignal } = {},
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetch(`${this.baseUrl}${path}`, { ...init, signal });
  }

  async send(
    request: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ ref: string }> {
    const response = await this.request('/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(request ?? null),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status >= 400 && response.status < 500)
        throw new EffectPermanentError(
          `effect_rejected_${response.status}:${body.slice(0, 200)}`,
          response.status,
        );
      throw new Error(`effect_upstream_${response.status}`);
    }
    const payload = (await response.json()) as MessageResponse;
    const ref = payload.message_id ?? payload.ref;
    if (!ref) throw new Error('effect_response_missing_ref');
    return { ref };
  }

  async lookup(idempotencyKey: string): Promise<{ ref: string } | null> {
    if (!this.supportsLookup) return null;
    const response = await this.request(
      `/messages?idempotency_key=${encodeURIComponent(idempotencyKey)}`,
      { method: 'GET' },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`effect_lookup_${response.status}`);
    const payload = (await response.json()) as MessageResponse;
    const ref = payload.message_id ?? payload.ref;
    return ref ? { ref } : null;
  }
}
