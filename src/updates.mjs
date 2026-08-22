/**
 * The "检查更新…" action, driven by the unified update manifest when one is
 * configured: one fetch answers both channels — a newer shell version opens
 * its installer download page, a newer pinned dsh version installs in place
 * (picked up on next launch). Without a manifest the shell channel is
 * skipped and dsh falls back to the registry dist-tag.
 */

import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell } from 'electron'
import { DSH_DIST_TAG, DSH_PACKAGE, REGISTRY, UPDATE_MANIFEST_URL } from './config.mjs'
import { installDsh, resolveVersion } from './dsh-install.mjs'
import { installedRuntimesDir, logsDir } from './paths.mjs'
import { activeDshVersion, compareVersions, nodeBin, pinDshVersion, pnpmShimDir } from './runtime.mjs'
import { applyShellUpdate } from './shell-updater.mjs'
import { fetchUpdateManifest, planUpdates } from './update-manifest.mjs'

let checking = false

/** Compute the update plan for both channels; no user feedback. */
async function resolvePlan() {
  const shellVersion = app.getVersion()
  const dshVersion = activeDshVersion()
  if (UPDATE_MANIFEST_URL !== null) {
    const manifest = await fetchUpdateManifest(UPDATE_MANIFEST_URL)
    return planUpdates(manifest, { shellVersion, dshVersion, platform: process.platform })
  }
  const plan = { shell: null, dsh: null }
  const latest = await resolveVersion(REGISTRY, DSH_PACKAGE, DSH_DIST_TAG)
  if (dshVersion === null || compareVersions(latest, dshVersion) > 0) plan.dsh = { version: latest }
  return plan
}

/**
 * Silent startup check: when something is updatable, light up the in-window
 * update pill (the preload renders it in the former title-bar seat). All
 * failures are swallowed — startup must never depend on the update host.
 * The pill click runs the same interactive flow as the menu item.
 * @param {import('electron').BrowserWindow} window the main window.
 */
export function watchForUpdates(window) {
  ipcMain.removeAllListeners('updates:apply')
  ipcMain.on('updates:apply', () => {
    void checkForUpdates().then(async () => {
      // Deferring ("稍后") keeps the pill; hide it only once nothing is left.
      const plan = await resolvePlan()
      if (plan.shell !== null || plan.dsh !== null) return
      if (!window.isDestroyed()) window.webContents.send('updates:applied')
    }).catch(() => {})
  })
  void resolvePlan().then((plan) => {
    if (window.isDestroyed() || (plan.shell === null && plan.dsh === null)) return
    const version = plan.shell?.version ?? plan.dsh?.version
    window.webContents.send('updates:available', { label: `发现新版本 ${version}` })
  }).catch(() => {})
}

/** Menu- or pill-triggered update check; owns all user feedback, never throws. */
export async function checkForUpdates() {
  if (checking) return
  checking = true
  try {
    const shellVersion = app.getVersion()
    const dshVersion = activeDshVersion()
    const plan = await resolvePlan()

    if (plan.shell !== null) {
      // Prefer the in-place Squirrel flow; fall back to the download page
      // when no feed is configured or the feed can't deliver (e.g. unsigned
      // mac build, feed not yet published).
      const handled = plan.shell.feed !== undefined
        && await applyShellUpdate(plan.shell.feed, plan.shell.version)
      if (!handled) {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message: `发现应用新版本 ${plan.shell.version}`,
          detail: '需要下载新的安装包完成升级。',
          buttons: plan.shell.url === undefined ? ['知道了'] : ['前往下载', '稍后'],
          defaultId: 0,
          cancelId: 1,
        })
        if (response === 0 && plan.shell.url !== undefined) void shell.openExternal(plan.shell.url)
      }
    }
    if (plan.dsh !== null) {
      await updateDsh(plan.dsh.version)
      return
    }
    if (plan.shell === null) {
      await dialog.showMessageBox({
        type: 'info',
        message: '已是最新版本',
        detail: `DeepSeek Harness ${dshVersion ?? '（未安装）'}\n应用 ${shellVersion}`,
      })
    }
  } catch (error) {
    dialog.showErrorBox('检查更新失败', error instanceof Error ? error.message : String(error))
  } finally {
    checking = false
  }
}

/** Download-install a dsh version, then offer the relaunch that activates it. */
async function updateDsh(version) {
  void dialog.showMessageBox({
    type: 'info',
    message: `发现 DeepSeek Harness 新版本 ${version}`,
    detail: '正在后台下载，完成后会再次提示。',
  })
  const log = createWriteStream(path.join(logsDir(), 'install.log'), { flags: 'a' })
  log.write(`\n===== update ${DSH_PACKAGE}@${version} ${new Date().toISOString()} =====\n`)
  try {
    await installDsh({
      runtimesRoot: installedRuntimesDir(),
      packageName: DSH_PACKAGE,
      version,
      registry: REGISTRY,
      nodeBinDir: path.dirname(nodeBin()),
      pnpmShimDir: pnpmShimDir(),
      onOutput: (line) => log.write(line),
    })
  } finally {
    log.end()
  }
  // Without moving the pin an older user-pinned version would win the next boot.
  pinDshVersion(version)
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `已更新到 ${version}`,
    detail: '重启应用后生效。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    app.relaunch()
    app.quit()
  }
}
