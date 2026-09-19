/**
 * Sidecar lifecycle: start the CommerceAgent Node backend as a child process.
 *
 * The backend ships as a plain Node program (`dist/index.js`) that serves both
 * the API and the built web UI (`./web/dist`) from its own cwd, and keeps all
 * runtime state under `COMMERCEAGENT_DATA_DIR`. Running it as a child process of
 * its own stock Node runtime is deliberate:
 *
 * - the native dependencies (`better-sqlite3`, `node-pty`) keep the ABI they were
 *   built with, so no `electron-rebuild` step is required;
 * - a crash or an `exit` in the backend cannot take the desktop shell with it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export interface SidecarConfig {
  /** Directory that contains `dist/`, `web/dist/`, `node_modules/` and `config/`. */
  appDir: string;
  /** Writable state directory (`COMMERCEAGENT_DATA_DIR`). */
  dataDir: string;
  /** Stock Node runtime used to run the backend. */
  nodeBinary: string;
  /** Optional file that receives the backend's stdout/stderr. */
  logFile?: string;
}

export interface SidecarHandle {
  readonly port: number;
  readonly origin: string;
  readonly pid: number | undefined;
  stop(): Promise<void>;
}

/** Ask the OS for a free loopback port (bind 0, read it, close). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() =>
          reject(new Error('could not determine a free port')),
        );
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function probeOnce(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

/** Poll `url` until it answers or `timeoutMs` elapses. */
export async function waitForReady(
  url: string,
  timeoutMs: number,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (child !== undefined && child.exitCode !== null) {
      throw new Error(
        `backend exited with code ${child.exitCode} before becoming ready`,
      );
    }
    if (await probeOnce(url)) return;
    lastError = `no response from ${url}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `backend did not become ready within ${timeoutMs}ms (${lastError})`,
  );
}

export async function startSidecar(
  config: SidecarConfig,
): Promise<SidecarHandle> {
  const entry = path.join(config.appDir, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `backend entry not found: ${entry} (run "npm run build" first)`,
    );
  }
  fs.mkdirSync(config.dataDir, { recursive: true });

  const port = await pickFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const logStream =
    config.logFile === undefined
      ? undefined
      : fs.createWriteStream(config.logFile, { flags: 'a' });

  const child = spawn(config.nodeBinary, [entry], {
    cwd: config.appDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WEB_PORT: String(port),
      COMMERCEAGENT_DATA_DIR: config.dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    logStream?.write(chunk);
    if (process.env.DESKTOP_SIDECAR_VERBOSE === '1')
      process.stdout.write(`[backend] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logStream?.write(chunk);
    if (process.env.DESKTOP_SIDECAR_VERBOSE === '1')
      process.stderr.write(`[backend] ${chunk.toString()}`);
  });

  try {
    await waitForReady(`${origin}/api/auth/status`, 60_000, child);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  return {
    port,
    origin,
    pid: child.pid,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          logStream?.end();
          resolve();
          return;
        }
        const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => {
          clearTimeout(force);
          logStream?.end();
          resolve();
        });
        child.kill('SIGTERM');
      }),
  };
}
