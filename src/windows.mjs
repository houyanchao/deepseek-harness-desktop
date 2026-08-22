/** The splash window and the main window (fixed header + embedded dsh view). */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BrowserWindow, screen, shell, WebContentsView } from 'electron'

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pages')

/** Permanent header height; the dsh view starts below it. */
const HEADER_HEIGHT = 36

/** The embedded dsh view of each main window. */
const views = new WeakMap()

export function createSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: true,
  })
  void splash.loadFile(path.join(PAGES, 'splash.html'))
  return splash
}

/** Update the splash status line; safe to call after the splash is closed. */
export function setSplashStatus(splash, text) {
  if (splash.isDestroyed()) return
  void splash.webContents.executeJavaScript(
    `document.getElementById('status').textContent = ${JSON.stringify(text)}`,
  ).catch(() => {})
}

/**
 * The main window is the shell's own header page (drag region, update pill,
 * future buttons); the dsh GUI loads in a WebContentsView laid out below the
 * header, so removing the native title bar costs no page real estate.
 */
export function createMainWindow(url) {
  // 90% of the work area (capped) so the app opens comfortably large.
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: Math.min(1760, Math.round(workArea.width * 0.9)),
    height: Math.min(1100, Math.round(workArea.height * 0.9)),
    show: false,
    title: '',
    // 'hiddenInset' sinks the traffic lights to vertically center in the 36px header.
    ...process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {},
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
    },
  })
  void window.loadFile(path.join(PAGES, 'chrome.html'), { query: { platform: process.platform } })

  const view = new WebContentsView()
  window.contentView.addChildView(view)
  const layout = () => {
    const { width, height } = window.getContentBounds()
    view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: height - HEADER_HEIGHT })
  }
  layout()
  window.on('resize', layout)
  views.set(window, view)
  // Links out of the dsh GUI belong in the system browser, not an Electron
  // popup: new windows are always handed over, and in-place navigation is
  // kept only for the local dsh server itself (its port changes per restart,
  // hence host-based matching) so an external link can't replace the GUI.
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target)
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).hostname === '127.0.0.1') return
    event.preventDefault()
    void shell.openExternal(target)
  })
  void view.webContents.loadURL(url)

  window.once('ready-to-show', () => window.show())
  return window
}

/** Point the embedded dsh view at a (new) server URL, e.g. after a restart. */
export function setAppUrl(window, url) {
  const view = views.get(window)
  if (view !== undefined) void view.webContents.loadURL(url)
}
