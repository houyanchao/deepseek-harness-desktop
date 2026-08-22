/**
 * In-place shell upgrade via Electron's built-in Squirrel autoUpdater, which
 * matches the Forge makers as-is: macOS consumes the maker-zip ZIP through a
 * JSON feed ({"url": "<zip url>"}), Windows consumes the maker-squirrel
 * RELEASES + .nupkg directory. macOS additionally requires the app to be
 * code-signed — Squirrel.Mac refuses to swap in an unsigned bundle.
 */

import { app, autoUpdater, dialog } from 'electron'

let updating = false

/**
 * Download and apply a shell update from a Squirrel feed, with dialogs for
 * consent and relaunch.
 *
 * @param {string} feedUrl the platform's feed from the update manifest.
 * @param {string} version the target version (display only).
 * @returns {Promise<boolean>} true when the auto flow handled it (including
 * a user deferral); false when unavailable and the caller should fall back
 * to the manual download page.
 */
export async function applyShellUpdate(feedUrl, version) {
  // Squirrel needs an installed (packaged) app to swap; dev runs can't.
  if (!app.isPackaged) return false
  if (updating) return true

  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `发现应用新版本 ${version}`,
    detail: '将在后台下载，完成后提示重启。',
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return true

  updating = true
  return await new Promise((resolve) => {
    const finish = (handled) => {
      autoUpdater.removeAllListeners('update-downloaded')
      autoUpdater.removeAllListeners('update-not-available')
      autoUpdater.removeAllListeners('error')
      updating = false
      resolve(handled)
    }
    autoUpdater.on('update-downloaded', () => {
      void dialog.showMessageBox({
        type: 'info',
        message: `新版本 ${version} 已就绪`,
        detail: '重启应用完成升级。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response: restart }) => {
        if (restart === 0) autoUpdater.quitAndInstall()
        finish(true)
      })
    })
    // The manifest said "newer" but the feed disagrees (e.g. not yet
    // published there) — hand over to the manual download fallback.
    autoUpdater.on('update-not-available', () => finish(false))
    autoUpdater.on('error', () => finish(false))
    autoUpdater.setFeedURL(process.platform === 'darwin'
      ? { url: feedUrl, serverType: 'json' }
      : { url: feedUrl })
    autoUpdater.checkForUpdates()
  })
}
