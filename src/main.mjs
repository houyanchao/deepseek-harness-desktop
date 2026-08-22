/** Entry: single instance, first-boot prep, dsh supervision, window lifecycle. */

import { app, dialog } from 'electron'
import { USER_DATA_DIR_NAME } from './config.mjs'
import { ensureDsh, pinUserDataDir, prepareHome, preinstallPlugins } from './bootstrap.mjs'
import { dshLogPath, startDshServer } from './dsh-server.mjs'
import { installAppMenu } from './menu.mjs'
import { cleanupOldRuntimes } from './runtime.mjs'
import { watchForUpdates } from './updates.mjs'
import { installVersionSwitcher } from './versions.mjs'
import { createMainWindow, createSplash, setAppUrl, setSplashStatus } from './windows.mjs'

pinUserDataDir(USER_DATA_DIR_NAME)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  run()
}

/** @type {{ stop: () => Promise<void> } | null} */
let server = null
let mainWindow = null
let quitting = false
let restartCount = 0
/** The URL the running dsh serves; refreshed on every (re)start (random port). */
let currentUrl = null

function run() {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => app.quit())

  app.on('before-quit', (event) => {
    if (quitting || server === null) return
    // Hold quit until the dsh child (and any pnpm it spawned) is down.
    event.preventDefault()
    quitting = true
    const pending = server
    server = null
    void pending.stop().finally(() => app.quit())
  })

  void app.whenReady().then(boot)
}

async function boot() {
  installAppMenu()
  const splash = createSplash()
  try {
    await prepareHome()
    await ensureDsh((status) => setSplashStatus(splash, status))
    await preinstallPlugins((status) => setSplashStatus(splash, status))
    setSplashStatus(splash, '正在启动 DeepSeek Harness…')
    const url = await startServer()
    mainWindow = createMainWindow(url)
    mainWindow.once('ready-to-show', () => {
      if (!splash.isDestroyed()) splash.close()
    })
    watchForUpdates(mainWindow)
    installVersionSwitcher(mainWindow, restartServer, () => currentUrl)
    void cleanupOldRuntimes().catch(() => {})
  } catch (error) {
    if (!splash.isDestroyed()) splash.close()
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `${error instanceof Error ? error.message : String(error)}\n\n`
      + `首次启动需要网络连接以下载 DeepSeek Harness，请检查网络后重新打开。\n\n日志：${dshLogPath()}`,
    )
    app.quit()
  }
}

/** Start dsh web; an unexpected child exit restarts it (bounded) and re-points the window. */
async function startServer() {
  const started = await startDshServer(({ exitCode }) => {
    server = null
    if (quitting) return
    restartCount += 1
    if (restartCount > 3) {
      dialog.showErrorBox(
        'DeepSeek Harness 已停止',
        `dsh 服务多次异常退出（最后一次退出码 ${exitCode}）。\n\n日志：${dshLogPath()}`,
      )
      app.quit()
      return
    }
    void startServer().then((url) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) setAppUrl(mainWindow, url)
    }).catch(() => {
      dialog.showErrorBox('DeepSeek Harness 已停止', `dsh 服务重启失败。\n\n日志：${dshLogPath()}`)
      app.quit()
    })
  })
  server = started
  currentUrl = started.url
  return started.url
}

/**
 * Stop the dsh child and boot the currently pinned version, re-pointing the
 * window; used by the version switcher. Rejects when the new child fails to
 * serve (the switcher rolls back the pin and calls this again).
 */
async function restartServer() {
  const pending = server
  server = null
  if (pending !== null) await pending.stop()
  restartCount = 0
  const url = await startServer()
  if (mainWindow !== null && !mainWindow.isDestroyed()) setAppUrl(mainWindow, url)
}
