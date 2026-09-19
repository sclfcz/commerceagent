/**
 * In-app updates through electron-updater.
 *
 * The update feed is the GitHub Release of this repository (see `publish` in
 * `electron-builder.yml`). Two constraints shape this module:
 *
 * - an unsigned macOS build cannot install an update, so failures stay silent and
 *   the user is only told about a version that was actually downloaded;
 * - update checks are for packaged builds only — running them in development would
 *   just log noise.
 */
import { app, dialog } from 'electron';

export function setupAutoUpdate(): void {
  if (!app.isPackaged) return;

  void (async () => {
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('update-downloaded', (info) => {
        void dialog
          .showMessageBox({
            type: 'info',
            message: `发现新版本 ${info.version}`,
            detail: '重启应用即可完成更新。',
            buttons: ['稍后', '立即重启'],
            defaultId: 1,
            cancelId: 0,
          })
          .then((result) => {
            if (result.response === 1) autoUpdater.quitAndInstall();
          });
      });

      await autoUpdater.checkForUpdates();
    } catch {
      // Offline, no release published yet, or an unsigned macOS build: the app
      // keeps working, the user just does not get an update prompt.
    }
  })();
}
