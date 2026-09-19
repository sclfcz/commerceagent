/**
 * Preload bridge for the CommerceAgent desktop shell.
 *
 * Hand-written CommonJS on purpose: a sandboxed preload cannot be an ES module,
 * and the surface is deliberately tiny — the renderer is the ordinary web app
 * served by the local sidecar, it only needs to know that it runs on the desktop.
 */
const { contextBridge } = require('electron');

const bridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
});

contextBridge.exposeInMainWorld('desktop', bridge);
