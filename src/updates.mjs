/**
 * The "检查更新…" action. This channel watches exactly one thing: whether the
 * shell itself is behind the version named in the update manifest. Which dsh
 * version runs is the user's call, made in the version picker — a newer dsh
 * on the manifest is an offer there, never a prompt here.
 */

import { app, dialog, ipcMain, shell } from 'electron'
import { UPDATE_MANIFEST_URL } from './config.mjs'
import { activeDshVersion } from './runtime.mjs'
import { applyShellUpdate } from './shell-updater.mjs'
import { fetchUpdateManifest, planUpdates } from './update-manifest.mjs'

let checking = false

/**
 * The shell update the manifest offers, or null when up to date (also when no
 * manifest is configured — with nothing to compare against, nothing is behind).
 * No user feedback.
 * @returns {Promise<{ version: string, url: string | undefined, feed: string | undefined } | null>}
 */
async function resolveShellUpdate() {
  if (UPDATE_MANIFEST_URL === null) return null
  const manifest = await fetchUpdateManifest(UPDATE_MANIFEST_URL)
  const plan = planUpdates(manifest, {
    shellVersion: app.getVersion(),
    dshVersion: activeDshVersion(),
    platform: process.platform,
    arch: process.arch,
  })
  return plan.shell
}

/**
 * Silent startup check: when this shell is behind the manifest, light up the
 * in-window update pill (the preload renders it in the former title-bar seat).
 * All failures are swallowed — startup must never depend on the update host.
 * The pill click runs the same interactive flow as the menu item.
 * @param {import('electron').BrowserWindow} window the main window.
 */
export function watchForUpdates(window) {
  // The pill is a pure function of "is this shell behind the manifest": every
  // evaluation either lights it or puts it away, so a shell that stops being
  // behind (upgraded, or the manifest rolled back) never leaves it stranded.
  const refresh = async () => {
    const update = await resolveShellUpdate()
    if (window.isDestroyed()) return
    if (update === null) window.webContents.send('updates:applied')
    else window.webContents.send('updates:available', { label: `发现新版本 ${update.version}` })
  }
  ipcMain.removeAllListeners('updates:apply')
  ipcMain.on('updates:apply', (event) => {
    // The pill lives in our own header page; nothing else may drive installs.
    if (window.isDestroyed() || event.sender !== window.webContents) return
    // Re-evaluating after the flow is what guarantees the pill goes away once
    // the shell is no longer behind; deferring ("稍后") legitimately keeps it.
    void checkForUpdates().then(refresh).catch(() => {})
  })
  void refresh().catch(() => {})
}

/** Menu- or pill-triggered update check; owns all user feedback, never throws. */
export async function checkForUpdates() {
  if (checking) return
  checking = true
  try {
    const update = await resolveShellUpdate()
    if (update === null) {
      await dialog.showMessageBox({
        type: 'info',
        message: '已是最新版本',
        detail: `应用 ${app.getVersion()}\nDeepSeek Harness ${activeDshVersion() ?? '（未安装）'}`,
      })
      return
    }
    // Prefer the in-place Squirrel flow; fall back to the download page when
    // no feed is configured or the feed can't deliver (e.g. unsigned mac
    // build, feed not yet published).
    const handled = update.feed !== undefined && await applyShellUpdate(update.feed, update.version)
    if (handled) return
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `发现应用新版本 ${update.version}`,
      detail: '需要下载新的安装包完成升级。',
      buttons: update.url === undefined ? ['知道了'] : ['前往下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0 && update.url !== undefined) void shell.openExternal(update.url)
  } catch (error) {
    dialog.showErrorBox('检查更新失败', error instanceof Error ? error.message : String(error))
  } finally {
    checking = false
  }
}
