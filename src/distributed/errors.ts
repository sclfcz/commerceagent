/** Shared executor error types (kept in one module to avoid import cycles). */

/** Thrown by an executor when the same run may succeed on a later attempt. */
export class RetryableError extends Error {
  constructor(message = 'retryable executor failure') {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Thrown internally when work is interrupted by an AbortSignal. */
export class ExecutorAbortedError extends Error {
  constructor(message = 'executor aborted') {
    super(message);
    this.name = 'ExecutorAbortedError';
  }
}
