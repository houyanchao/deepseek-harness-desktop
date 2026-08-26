/**
 * The tray icon that keeps the app (and the dsh server) alive after the main
 * window closes: closing the window only hides it, and this is the always-on
 * handle to reopen or truly quit.
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { app, Menu, Tray } from 'electron'
import { checkForUpdates } from './updates.mjs'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

/** Module-scoped so the Tray is never garbage-collected (that removes the icon). */
let tray = null

/** Windows-only "still running" balloon, shown at most once per app run. */
let balloonShown = false

/**
 * @param {() => void} showMainWindow re-shows and focuses the hidden main window.
 */
export function installTray(showMainWindow) {
  // mac: the "Template" filename suffix makes Electron mark the image as a
  // template, so the menu bar recolors it for dark/light appearance.
  // win: the .ico carries a native 16px rendition for the notification area.
  const icon = process.platform === 'win32'
    ? path.join(ASSETS, 'icon.ico')
    : path.join(ASSETS, 'trayTemplate.png')
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: () => showMainWindow() },
    { label: '检查更新…', click: () => void checkForUpdates() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  // Windows convention: left click reopens the window, the menu stays on
  // right click. On mac any click opens the menu, so no handler is needed.
  if (process.platform === 'win32') {
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
  }
}

/**
 * Tell the user the close button hid the window instead of quitting. Only
 * Windows needs this (its close button usually means quit); on mac a closed
 * window leaving the app running is the platform norm.
 */
export function notifyHiddenToTray() {
  if (process.platform !== 'win32' || tray === null || balloonShown) return
  balloonShown = true
  tray.displayBalloon({
    title: 'DeepSeek Harness 仍在运行',
    content: '窗口已隐藏到系统托盘，后台任务继续执行。点击托盘图标可重新打开，右键可退出。',
    iconType: 'info',
  })
}
