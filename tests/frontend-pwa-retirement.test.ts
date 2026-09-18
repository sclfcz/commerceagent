import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isLegacyCommerceAgentRegistration,
  isLegacyPwaCacheName,
} from '../web/src/utils/legacyPwaCleanup';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('PWA cache retirement', () => {
  test('removes Workbox generation and runtime API caching', () => {
    const viteConfig = read('web/vite.config.ts');
    const packageJson = JSON.parse(read('web/package.json')) as {
      devDependencies?: Record<string, string>;
    };

    expect(viteConfig).not.toMatch(/VitePWA|workbox|runtimeCaching/);
    expect(packageJson.devDependencies).not.toHaveProperty('vite-plugin-pwa');
  });

  test('keeps the mobile standalone manifest without registering a worker', () => {
    const html = read('web/index.html');
    const main = read('web/src/main.tsx');
    const manifest = JSON.parse(read('web/public/manifest.webmanifest')) as {
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ sizes: string; purpose?: string }>;
    };

    expect(html).toContain(
      '<link rel="manifest" href="%BASE_URL%manifest.webmanifest" />',
    );
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(main).toContain('cleanupLegacyPwaArtifacts');
    expect(main).not.toMatch(/serviceWorker\.register|registerSW/);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./chat');
    expect(manifest.scope).toBe('./');
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    );
  });

  test('ships a non-caching self-destruct worker for old installations', () => {
    const worker = read('web/public/sw.js');

    expect(worker).toContain('self.skipWaiting()');
    expect(worker).toContain('self.registration.unregister()');
    expect(worker).toContain('client.navigate(client.url)');
    expect(worker).not.toMatch(/addEventListener\(['"]fetch|cache\.put|addAll/);
  });

  test('recognizes only CommerceAgent legacy caches and registrations', () => {
    expect(
      isLegacyPwaCacheName('workbox-precache-v2-https://example.com/'),
    ).toBe(true);
    expect(isLegacyPwaCacheName('api-groups-cache')).toBe(true);
    expect(isLegacyPwaCacheName('unrelated-product-cache')).toBe(false);

    const appScope = 'https://example.com/commerceagent/';
    const scriptUrl = `${appScope}sw.js`;
    const worker = { scriptURL: scriptUrl } as ServiceWorker;
    const registration = {
      scope: appScope,
      active: worker,
      waiting: null,
      installing: null,
    };
    expect(
      isLegacyCommerceAgentRegistration(registration, appScope, scriptUrl),
    ).toBe(true);
    expect(
      isLegacyCommerceAgentRegistration(
        {
          ...registration,
          scope: 'https://example.com/other/',
          active: {
            scriptURL: 'https://example.com/other/sw.js',
          } as ServiceWorker,
        },
        appScope,
        scriptUrl,
      ),
    ).toBe(false);
  });

  test('rebuild detection includes mobile manifest and cleanup worker assets', () => {
    const makefile = read('Makefile');
    const webServer = read('src/web.ts');

    expect(makefile).toContain(
      'find web/src/ web/public/ -type f -newer web/dist/index.html',
    );
    expect(webServer).toContain("p === '/index.html'");
    expect(webServer).toContain("p === '/sw.js'");
    expect(webServer).toContain("'no-cache, no-store, must-revalidate'");
  });
});
