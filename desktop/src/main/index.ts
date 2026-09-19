/**
 * CommerceAgent desktop shell.
 *
 * Security posture (Electron 20+ defaults, enforced here on purpose):
 * - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
 * - renderer talks to the desktop only through the typed `window.desktop` bridge;
 * - navigation is restricted to the local sidecar origin, external links open in
 *   the OS browser;
 * - a restrictive Content-Security-Policy is attached to every response.
 */
import { app, BrowserWindow, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startSidecar, type SidecarHandle } from './sidecar.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** `desktop/dist/main` → up three levels is the repository root in development. */
const DEV_REPO_ROOT = path.resolve(currentDir, '..', '..', '..');

const isPackaged = app.isPackaged;

/** Directory holding `dist/`, `web/dist/`, `node_modules/`, `config/`. */
const appDir = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : DEV_REPO_ROOT;

/** Writable state: database, uploads, workspaces, session secret. */
const dataDir = path.join(app.getPath('userData'), 'data');

/** Prefer the Node runtime shipped with the app; fall back to PATH in development. */
function resolveNodeBinary(): string {
  const bundled = path.join(
    process.resourcesPath,
    'node',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  if (isPackaged && fs.existsSync(bundled)) return bundled;
  return process.env.npm_node_execpath ?? 'node';
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

let sidecar: SidecarHandle | undefined;
let mainWindow: BrowserWindow | undefined;

async function createWindow(origin: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'CommerceAgent',
    backgroundColor: '#eef1f7',
    webPreferences: {
      preload: path.join(currentDir, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // External links always leave the app; nothing navigates the shell away from
  // the local sidecar.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://'))
      void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://'))
        void shell.openExternal(url);
    }
  });

  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
  return window;
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

// A desktop shell must be a single instance: two windows would mean two sidecars
// fighting over the same SQLite database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    applyCsp();
    try {
      sidecar = await startSidecar({
        appDir,
        dataDir,
        nodeBinary: resolveNodeBinary(),
        logFile: path.join(app.getPath('userData'), 'backend.log'),
      });
      mainWindow = await createWindow(sidecar.origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mainWindow = new BrowserWindow({
        width: 720,
        height: 420,
        title: 'CommerceAgent',
      });
      await mainWindow.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<body style="font:14px -apple-system,sans-serif;padding:32px"><h2>后端启动失败</h2><pre style="white-space:pre-wrap">${message}</pre><p>日志：${path.join(app.getPath('userData'), 'backend.log')}</p></body>`,
        )}`,
      );
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && sidecar !== undefined) {
      void createWindow(sidecar.origin).then((created) => {
        mainWindow = created;
      });
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Stop the backend before the process disappears so SQLite closes cleanly.
  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown || sidecar === undefined) return;
    shuttingDown = true;
    event.preventDefault();
    void sidecar.stop().finally(() => app.quit());
  });
}
