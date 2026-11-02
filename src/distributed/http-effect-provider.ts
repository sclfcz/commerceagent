import {
  EffectNotAppliedError,
  EffectPermanentError,
  type EffectProvider,
} from './durable.js';

export interface HttpEffectProviderOptions {
  /** Base URL of the mock/real messaging service, e.g. http://127.0.0.1:8099 */
  baseUrl: string;
  /** Whether the service exposes GET /messages?idempotency_key=... */
  supportsLookup?: boolean;
  name?: string;
  /** Per-request timeout; the durable context also enforces its own budget. */
  requestTimeoutMs?: number;
  /**
   * Statuses that mean "the provider did not accept the request", so retrying
   * does not need reconciliation. 500 and other 5xx stay "unknown".
   */
  notAppliedStatuses?: number[];
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
const NOT_APPLIED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Returns the socket error code when the request provably never left. */
function connectionErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_APPLIED_CODES.has(code)) return code;
    const cause = (current as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      current = cause;
      continue;
    }
    break;
  }
  return null;
}

export class HttpEffectProvider implements EffectProvider {
  readonly name: string;
  readonly supportsLookup: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly notAppliedStatuses: Set<number>;

  constructor(options: HttpEffectProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.supportsLookup = options.supportsLookup ?? true;
    this.name = options.name ?? 'http-mock';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.notAppliedStatuses = new Set(options.notAppliedStatuses ?? [429, 503]);
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
    let response: Response;
    try {
      response = await this.request('/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(request ?? null),
        signal,
      });
    } catch (error) {
      // The request never reached the service (connection refused / DNS).
      const code = connectionErrorCode(error);
      if (code)
        throw new EffectNotAppliedError(`effect_not_applied_${code}`, code);
      throw error;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (this.notAppliedStatuses.has(response.status))
        throw new EffectNotAppliedError(
          `effect_not_applied_${response.status}:${body.slice(0, 200)}`,
          `status_${response.status}`,
        );
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
