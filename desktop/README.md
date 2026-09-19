# CommerceAgent Desktop

Electron shell that packages CommerceAgent as a desktop application. It bundles the
existing Node backend and web UI; the backend runs as a **sidecar child process** on
its own stock Node runtime, and the window simply loads the loopback URL the backend
serves.

## Why a sidecar instead of running the server inside Electron

- `better-sqlite3` and `node-pty` are native modules built for the Node ABI. Reusing
  Electron's ABI would require `electron-rebuild` per platform and arch; a stock Node
  runtime keeps the backend identical to its normal deployment.
- A backend crash cannot take the desktop shell with it, and the backend stays
  inspectable (its stdout/stderr land in `backend.log` next to the app data).

## Layout

```
desktop/
├── src/main/index.ts      # app lifecycle, window, CSP, navigation hardening
├── src/main/sidecar.ts    # free-port selection, spawn, readiness probe, shutdown
├── src/preload/index.cjs  # sandboxed contextBridge (hand-written CommonJS)
├── scripts/fetch-node.mjs # vendors the stock Node runtime for packaging
└── electron-builder.yml   # dmg (arm64 + x64) and NSIS targets
```

## Data and paths

| What                                                                                | Where                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| App bundle (backend `dist/`, `web/dist/`, `node_modules/`, `config/`, `container/`) | packaged `Resources/app`, dev repository root                                     |
| Writable state (SQLite, uploads, workspaces, session secret)                        | `app.getPath('userData')/data`, passed to the backend as `COMMERCEAGENT_DATA_DIR` |
| Backend log                                                                         | `app.getPath('userData')/backend.log`                                             |

The backend resolves its data directory from `COMMERCEAGENT_DATA_DIR` (added in
`src/config.ts`) because a packaged `.app` bundle is read-only; `./web/dist` and
`config/` stay relative to the backend's working directory.

## Commands

```bash
npm --prefix desktop install          # once
npm run build                         # backend (produces dist/)
npm run build:web                     # web UI (produces web/dist/)
npm --prefix desktop run fetch-node   # vendor the stock Node runtime
npm --prefix desktop run dev          # compile the shell and launch it
npm --prefix desktop run dist:mac     # dmg for arm64 + x64
npm --prefix desktop run dist:win     # NSIS installer for x64
```

## Packaging notes

`npm run stage` prepares `desktop/.runtime/` — the payload that ends up in
`Resources/app`:

1. copy `dist/`, `web/dist/`, `config/`, `container/`, `package.json`, `package-lock.json`;
2. run `npm ci --omit=dev` with the **vendored Node** and with that Node first on
   `PATH`, so `better-sqlite3` and `node-pty` are installed for the runtime that
   actually loads them.

Skipping step 2's PATH change is the classic failure mode: `prebuild-install`
resolves the target runtime by shelling out to `node`, picks up the host Node, and
the app then dies with `NODE_MODULE_VERSION 147 ... requires 127`. The same reason
is why `npmRebuild: false` is set for electron-builder: the shell has no native
dependencies of its own, and rebuilding the backend tree with Electron's ABI would
break the sidecar.

## Verification

| Check                                                               | Result                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `node dist/index.js` with `WEB_PORT`/`COMMERCEAGENT_DATA_DIR`       | `/api/auth/status` → `200`, state written to the override directory, repository `data/` untouched |
| `desktop` in development (`electron .`)                             | sidecar on a free port, window loads the local UI, setup page renders, backend killed on quit     |
| Packaged `.app` (`electron-builder --dir`), launched via Playwright | sidecar on a free port, UI renders from `Resources/app`, no orphan process after quit             |

## Security

`contextIsolation` and `sandbox` are on and `nodeIntegration` is off; the renderer is
a normal web page served over loopback. A restrictive CSP is attached to every
response, external links open in the OS browser, and navigation is locked to the
sidecar origin. The preload exposes only `window.desktop = { isDesktop, platform,
electron, chrome }`.

## Unsigned builds

There is no Apple Developer account yet, so macOS builds are unsigned and every
download lands in quarantine. Users have to approve the app once:

1. Right-click the app → **打开** (Open) → **打开** again, or
2. System Settings → **隐私与安全性** → **仍要打开**, or
3. `xattr -dr com.apple.quarantine /Applications/CommerceAgent.app`

Windows builds are unsigned too: SmartScreen shows _"Windows 已保护你的电脑"_ once and
the user clicks **更多信息 → 仍要运行**.
