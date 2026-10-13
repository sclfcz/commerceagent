import fs from 'node:fs';
import path from 'node:path';

/** Enforce egress independently of Promptfoo's telemetry opt-out behavior. */
export function installPromptfooNetworkGuard(
  allowedApiPrefixes: string[],
  allowLoopback = false,
) {
  const allowed = allowedApiPrefixes.map((value) => new URL(value));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const loopback =
      allowLoopback &&
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const approved = allowed.some(
      (prefix) =>
        url.origin === prefix.origin &&
        (url.pathname === prefix.pathname ||
          url.pathname.startsWith(prefix.pathname.replace(/\/$/, '') + '/')),
    );
    if (!loopback && !approved)
      throw new Error('benchmark_unapproved_network_destination');
    // Do not allow an approved URL to redirect a credential to another origin.
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export function configurePromptfooStorage(promptfooDirectory: string) {
  const configDirectory = path.join(promptfooDirectory, 'config');
  const cacheDirectory = path.join(promptfooDirectory, 'cache');
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    PROMPTFOO_CONFIG_DIR: configDirectory,
    PROMPTFOO_CACHE_PATH: cacheDirectory,
    PROMPTFOO_CACHE_ENABLED: 'false',
    PROMPTFOO_DISABLE_TELEMETRY: '1',
    PROMPTFOO_DISABLE_UPDATE: '1',
    PROMPTFOO_DISABLE_SHARING: '1',
  });
  return { configDirectory, cacheDirectory };
}
