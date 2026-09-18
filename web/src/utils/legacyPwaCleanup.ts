const LEGACY_CACHE_NAMES = new Set([
  'api-core-cache',
  'api-groups-cache',
  'google-fonts-cache',
  'gstatic-fonts-cache',
  'local-fonts-cache',
  'mermaid-runtime-cache',
]);

export function isLegacyPwaCacheName(name: string): boolean {
  return name.startsWith('workbox-') || LEGACY_CACHE_NAMES.has(name);
}

function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function isLegacyCommerceAgentRegistration(
  registration: Pick<
    ServiceWorkerRegistration,
    'scope' | 'active' | 'waiting' | 'installing'
  >,
  appScope: string,
  legacyScriptUrl: string,
): boolean {
  if (normalizeUrl(registration.scope) === normalizeUrl(appScope)) return true;

  return [
    registration.active,
    registration.waiting,
    registration.installing,
  ].some((worker) => worker?.scriptURL === legacyScriptUrl);
}

/**
 * Remove registrations and Cache Storage left by CommerceAgent releases that used
 * Workbox. The cleanup is deliberately best-effort and never blocks rendering.
 */
export async function cleanupLegacyPwaArtifacts(): Promise<void> {
  if (typeof window === 'undefined') return;

  const appScope = new URL(import.meta.env.BASE_URL, window.location.origin)
    .href;
  const legacyScriptUrl = new URL('sw.js', appScope).href;
  const tasks: Promise<unknown>[] = [];

  if ('serviceWorker' in navigator) {
    tasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.allSettled(
            registrations
              .filter((registration) =>
                isLegacyCommerceAgentRegistration(
                  registration,
                  appScope,
                  legacyScriptUrl,
                ),
              )
              .map((registration) => registration.unregister()),
          ),
        ),
    );
  }

  if ('caches' in window) {
    tasks.push(
      caches
        .keys()
        .then((names) =>
          Promise.allSettled(
            names
              .filter(isLegacyPwaCacheName)
              .map((name) => caches.delete(name)),
          ),
        ),
    );
  }

  await Promise.allSettled(tasks);
}
