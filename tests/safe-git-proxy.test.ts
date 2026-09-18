import net from 'node:net';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildPinnedGitEnvironment,
  startPinnedHttpsProxy,
  type PinnedHttpsProxy,
} from '../src/safe-git-proxy.js';

const openServers: net.Server[] = [];
const openProxies: PinnedHttpsProxy[] = [];

afterEach(async () => {
  await Promise.allSettled(openProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.allSettled(
    openServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

function listen(server: net.Server): Promise<number> {
  openServers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Missing test server address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function proxyPort(proxy: PinnedHttpsProxy): number {
  return Number(new URL(proxy.url).port);
}

function connectResponse(port: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
      if (
        response.includes('403 Forbidden') ||
        response.includes('502 Bad Gateway') ||
        response.includes('upstream-ready')
      ) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
  });
}

describe('startPinnedHttpsProxy', () => {
  test('removes inherited Git/proxy bypass configuration', () => {
    const env = buildPinnedGitEnvironment('http://127.0.0.1:1234', {
      PATH: '/bin',
      NO_PROXY: '*',
      GIT_CONFIG_PARAMETERS: "'url.file:///tmp/.insteadOf=https://'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: '',
    });

    expect(env.PATH).toBe('/bin');
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:1234');
    expect(env.NO_PROXY).toBe('');
  });

  test('dials the validated IP literal while preserving the requested TLS hostname', async () => {
    const upstreamPort = await listen(
      net.createServer((socket) => socket.write('upstream-ready')),
    );
    const resolveAddresses = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const connectAddress = vi.fn((address, port) => {
      expect(address.address).toBe('93.184.216.34');
      expect(port).toBe(443);
      return net.connect({ host: '127.0.0.1', port: upstreamPort });
    });
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses,
      connectAddress,
    });
    openProxies.push(proxy);

    const response = await connectResponse(
      proxyPort(proxy),
      'git.example.test:443',
    );
    expect(response).toContain('200 Connection Established');
    expect(response).toContain('upstream-ready');
    expect(resolveAddresses).toHaveBeenCalledWith(
      'git.example.test',
      'init_git_url hostname',
    );
    expect(connectAddress).toHaveBeenCalledTimes(1);
  });

  test('rejects redirects or CONNECT attempts to any other hostname', async () => {
    const resolveAddresses = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses,
    });
    openProxies.push(proxy);

    const response = await connectResponse(
      proxyPort(proxy),
      'metadata.internal:443',
    );
    expect(response).toContain('403 Forbidden');
    expect(resolveAddresses).not.toHaveBeenCalled();
  });

  test('rejects a DNS answer that rebinds to a private address at connect time', async () => {
    const connectAddress = vi.fn(() => net.connect(9, '127.0.0.1'));
    const proxy = await startPinnedHttpsProxy('git.example.test', {
      resolveAddresses: async () => [{ address: '169.254.169.254', family: 4 }],
      connectAddress,
    });
    openProxies.push(proxy);

    const response = await connectResponse(
      proxyPort(proxy),
      'git.example.test:443',
    );
    expect(response).toContain('502 Bad Gateway');
    expect(connectAddress).not.toHaveBeenCalled();
  });
});
