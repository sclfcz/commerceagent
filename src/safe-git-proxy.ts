import http from 'node:http';
import net from 'node:net';

import {
  isPrivateHostname,
  resolvePublicAddresses,
  type ResolvedPublicAddress,
} from './url-safety.js';

type ResolveAddresses = (
  hostname: string,
  label?: string,
) => Promise<ResolvedPublicAddress[]>;
type ConnectAddress = (
  address: ResolvedPublicAddress,
  port: number,
) => net.Socket;

export interface PinnedHttpsProxy {
  url: string;
  close(): Promise<void>;
}

/** Build an environment that cannot bypass the pinned proxy through inherited
 * Git config injection or NO_PROXY settings. Global/system config is disabled
 * so url.*.insteadOf and URL-specific proxy rules cannot change the transport. */
export function buildPinnedGitEnvironment(
  proxyUrl: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      key === 'GIT_CONFIG_PARAMETERS' ||
      key === 'GIT_CONFIG_SYSTEM' ||
      key === 'GIT_CONFIG_GLOBAL' ||
      key === 'GIT_CONFIG_NOSYSTEM' ||
      key === 'GIT_CONFIG_COUNT' ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: '',
    no_proxy: '',
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

function parseConnectAuthority(authority: string | undefined): {
  hostname: string;
  port: number;
} | null {
  if (!authority) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return { hostname: normalizeHostname(parsed.hostname), port };
  } catch {
    return null;
  }
}

async function connectFirstAvailable(
  addresses: ResolvedPublicAddress[],
  port: number,
  connectAddress: ConnectAddress,
): Promise<net.Socket> {
  let lastError: Error | undefined;
  for (const address of addresses) {
    try {
      const socket = connectAddress(address, port);
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off('connect', onConnect);
          reject(error);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
      return socket;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('No validated address was available');
}

/**
 * Start a loopback CONNECT proxy that resolves, validates and then dials the
 * validated IP directly for every TLS connection. Git still performs normal
 * certificate validation for the original hostname through the tunnel, while
 * DNS rebinding cannot redirect the socket to a private address between the
 * safety check and connect(2).
 */
export async function startPinnedHttpsProxy(
  expectedHostname: string,
  dependencies: {
    expectedPort?: number;
    resolveAddresses?: ResolveAddresses;
    connectAddress?: ConnectAddress;
  } = {},
): Promise<PinnedHttpsProxy> {
  const expected = normalizeHostname(expectedHostname);
  const expectedPort = dependencies.expectedPort ?? 443;
  if (
    !Number.isInteger(expectedPort) ||
    expectedPort <= 0 ||
    expectedPort > 65_535
  ) {
    throw new Error('Invalid HTTPS proxy target port');
  }
  const resolveAddresses =
    dependencies.resolveAddresses ?? resolvePublicAddresses;
  const connectAddress =
    dependencies.connectAddress ??
    ((address, port) =>
      net.connect({ host: address.address, family: address.family, port }));
  const sockets = new Set<net.Socket>();

  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close' });
    response.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', async (request, clientSocket, head) => {
    const target = parseConnectAuthority(request.url);
    if (
      !target ||
      target.port !== expectedPort ||
      target.hostname !== expected
    ) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    try {
      // Resolve at the moment of connection, validate all answers, then dial
      // an IP literal. No subsequent DNS lookup occurs in net.connect.
      const addresses = await resolveAddresses(
        target.hostname,
        'init_git_url hostname',
      );
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isPrivateHostname(address))
      ) {
        throw new Error(
          'init_git_url hostname resolves to a private or link-local address',
        );
      }
      const upstream = await connectFirstAvailable(
        addresses,
        target.port,
        (address, port) => {
          const socket = connectAddress(address, port);
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
          return socket;
        },
      );
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    } catch {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to start pinned HTTPS proxy');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
