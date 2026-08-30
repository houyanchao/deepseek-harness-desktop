/**
 * Version management. The header button opens a dedicated child window (the
 * dsh WebContentsView covers everything below the header, so an in-page
 * dropdown or dialog would be hidden behind it) listing every offered
 * version with its release date and size. Picking one pins it and restarts
 * the dsh child in place; downloads stay side by side (see
 * cleanupOldRuntimes' retention policy) so switching back is instant and
 * offline-safe, and a version that fails to boot rolls back automatically.
 * Idle downloads can be removed by hand to reclaim disk space, and the
 * running one can be restarted in place.
 */

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { DSH_PACKAGE, REGISTRY, UPDATE_MANIFEST_URL } from './config.mjs'
import {
  compareVersions,
  fetchVersionCatalog,
  installDsh,
  installedSize,
  isInstalled,
  isVersionName,
  parsePnpmPercent,
} from './dsh-install.mjs'
import { installedRuntimesDir, logsDir } from './paths.mjs'
import { curatedDshVersions, fetchUpdateManifest } from './update-manifest.mjs'
import { activeDshVersion, installedDshVersions, nodeBin, pinDshVersion, pnpmShimDir } from './runtime.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let switching = false
/** Reads the running dsh's URL; the picker shows its port on the current row. */
let getAppUrl = () => null
/** @type {import('electron').BrowserWindow | null} */
let versionsWindow = null
/** Resolves when the picker page finished loading (guards early sends). */
let pageLoaded = Promise.resolve()

/**
 * Wire the header version button: label updates, the picker window, and the
 * switch requests it sends.
 * @param {import('electron').BrowserWindow} window the main window.
 * @param {() => Promise<void>} restartServer stops the dsh child and boots the pinned version.
 * @param {() => string | null} appUrl the URL the running dsh serves (fresh port on every restart).
 */
export function installVersionSwitcher(window, restartServer, appUrl) {
  getAppUrl = appUrl
  const sendCurrent = () => {
    if (window.isDestroyed()) return
    window.webContents.send('versions:current', { version: activeDshVersion() })
  }
  // The page loaded long before this runs (boot awaits the dsh server first),
  // so send now; the load listener covers reloads of the header page.
  sendCurrent()
  window.webContents.on('did-finish-load', sendCurrent)

  ipcMain.removeAllListeners('versions:open')
  ipcMain.on('versions:open', (event) => {
    if (!isFrom(event, window)) return
    openVersionsWindow(window)
  })
  ipcMain.removeAllListeners('versions:switch')
  // The picker stays open during the switch: it renders the download/start
  // progress itself; on success it closes and a toast confirms.
  ipcMain.on('versions:switch', (event, version) => {
    if (!fromPicker(event, version)) return
    void switchTo(window, version, () => restartServer().then(sendCurrent))
  })
  ipcMain.removeAllListeners('versions:remove')
  ipcMain.on('versions:remove', (event, version) => {
    if (!fromPicker(event, version)) return
    void removeVersion(window, version)
  })
  ipcMain.removeAllListeners('versions:restart')
  ipcMain.on('versions:restart', (event) => {
    if (!isFrom(event, versionsWindow)) return
    void restartCurrent(window, () => restartServer().then(sendCurrent))
  })
}

/**
 * Whether a message came from the shell page we wired the channel for. These
 * channels drive installs and deletions, so they answer only to our own
 * chrome — never to the dsh GUI (which has no preload today, but must not
 * become a path to them if it ever gains one).
 * @param {import('electron').IpcMainEvent} event
 * @param {import('electron').BrowserWindow | null} expected
 */
function isFrom(event, expected) {
  return expected !== null && !expected.isDestroyed() && event.sender === expected.webContents
}

/**
 * Guard for the picker's version-scoped channels: right sender, and a version
 * string that cannot escape the runtimes directory once joined into a path.
 * @param {import('electron').IpcMainEvent} event
 * @param {unknown} version
 */
function fromPicker(event, version) {
  return isFrom(event, versionsWindow) && isVersionName(version)
}

/**
 * Restart the dsh child on the version already pinned — the escape hatch for
 * a wedged server, without the download/rollback machinery of a switch. The
 * child gets a fresh port, so the picker closes rather than showing a stale
 * one, and a toast confirms.
 */
async function restartCurrent(window, restartAndRefresh) {
  const version = activeDshVersion()
  if (switching || version === null) return
  switching = true
  try {
    sendProgress({ phase: 'restarting', version })
    await restartAndRefresh()
    if (versionsWindow !== null && !versionsWindow.isDestroyed()) versionsWindow.close()
    if (!window.isDestroyed()) showToast(window, `已重启 DeepSeek Harness ${version}`)
  } catch (error) {
    sendProgress({ phase: 'error' })
    dialog.showErrorBox('重启失败', error instanceof Error ? error.message : String(error))
  } finally {
    switching = false
    void sendCatalog().catch(() => {})
  }
}

/** Matches the row-out animation in pages/versions.html. */
const ROW_REMOVE_MS = 260

/**
 * Delete an idle download after confirmation. Refuses the running version
 * (its files are in use) and anything mid-switch. The row collapses out
 * before the refreshed list lands, and a toast confirms.
 */
async function removeVersion(window, version) {
  if (switching || version === activeDshVersion()) return
  const parent = versionsWindow !== null && !versionsWindow.isDestroyed() ? versionsWindow : window
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message: `删除 DeepSeek Harness ${version}？`,
    detail: '只删除这个版本的程序文件，你的插件、工作区和会话数据不受影响。之后仍可重新下载。',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return
  try {
    await rm(path.join(installedRuntimesDir(), version), { recursive: true, force: true })
    if (versionsWindow !== null && !versionsWindow.isDestroyed()) {
      versionsWindow.webContents.send('versions:removed', version)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, ROW_REMOVE_MS))
    }
    if (!window.isDestroyed()) showToast(window, `已删除 DeepSeek Harness ${version}`)
  } catch (error) {
    dialog.showErrorBox('删除版本失败', error instanceof Error ? error.message : String(error))
  } finally {
    void sendCatalog().catch(() => {})
  }
}

/** Open (or focus) the singleton picker window and feed it the catalog. */
function openVersionsWindow(parent) {
  if (versionsWindow !== null && !versionsWindow.isDestroyed()) {
    versionsWindow.focus()
    return
  }
  // Centered on the main window: the default child placement sits low.
  const area = parent.getBounds()
  const width = 560
  const height = 620
  versionsWindow = new BrowserWindow({
    parent,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // No system title bar: even disabled, the mac traffic-light trio reads as
    // three actions on a window that only supports one. The page draws its own
    // single close button and drags by its header instead.
    frame: false,
    show: false,
    title: 'DeepSeek Harness 版本列表',
    backgroundColor: '#f5f6f8',
    // Spelled out rather than inherited: these are Electron's defaults today,
    // and a major-version change of them must not silently widen this window.
    webPreferences: {
      preload: path.join(APP_ROOT, 'src', 'versions-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  versionsWindow.setMenuBarVisibility(false)
  versionsWindow.on('closed', () => {
    versionsWindow = null
  })
  pageLoaded = new Promise((resolvePromise) => versionsWindow.webContents.once('did-finish-load', resolvePromise))
  void versionsWindow.loadFile(path.join(APP_ROOT, 'pages', 'versions.html'))
  versionsWindow.once('ready-to-show', () => versionsWindow?.show())
  void sendCatalog()
}

/**
 * Assemble the picker's version list and push it to the page.
 *
 * When the update manifest curates versions (dsh.versions) it is the
 * allowlist — only hand-verified releases are offered, and the registry
 * merely decorates them with release dates. A configured-but-unreachable
 * manifest fails closed (downloaded-only) so the curation gate never
 * silently opens. Without a manifest the registry's full list is offered.
 */
async function sendCatalog() {
  const installed = installedDshVersions()

  const [curated, registry, sizePairs] = await Promise.all([
    UPDATE_MANIFEST_URL === null
      ? null
      : fetchUpdateManifest(UPDATE_MANIFEST_URL).then(curatedDshVersions).catch((error) => {
          // Fail closed (curation must not silently open up), but leave a trace
          // for diagnosing the picker's "无法获取版本清单" notice.
          console.error(`[versions] 清单拉取失败（${UPDATE_MANIFEST_URL}）：`, error)
          return undefined
        }),
    fetchVersionCatalog(REGISTRY, DSH_PACKAGE).catch(() => null),
    // Real on-disk sizes; slow only the first time per version (then cached
    // in a .size marker), while the page shows its loading state.
    Promise.all(installed.map(async (version) => [
      version,
      await installedSize(installedRuntimesDir(), version).catch(() => null),
    ])),
  ])
  const diskSizes = new Map(sizePairs)
  const measured = [...diskSizes.values()].filter((size) => size !== null)
  // Not-installed versions can only be estimated — dsh installs are all in
  // the same few-hundred-MB ballpark, so the installed average is honest
  // enough when labeled as an estimate.
  const estimate = measured.length === 0
    ? null
    : Math.round(measured.reduce((sum, size) => sum + size, 0) / measured.length)

  let entries = []
  let notice = null
  if (curated === undefined) {
    notice = '无法获取版本清单，仅显示本机已下载的版本。'
  } else if (curated !== null) {
    entries = curated.map((version) => ({
      version,
      publishedAt: registry?.find((entry) => entry.version === version)?.publishedAt ?? null,
    }))
  } else if (registry !== null) {
    entries = registry.map(({ version, publishedAt }) => ({ version, publishedAt }))
  } else {
    notice = '无法连接版本源，仅显示本机已下载的版本。'
  }

  // Downloaded versions outside the offered list still must show: they are on
  // disk and switching back to them must stay possible.
  for (const version of installed) {
    if (!entries.some((entry) => entry.version === version)) {
      entries.push({ version, publishedAt: null })
    }
  }
  entries.sort((a, b) => compareVersions(b.version, a.version))
  await pageLoaded
  if (versionsWindow === null || versionsWindow.isDestroyed()) return
  const url = getAppUrl()
  versionsWindow.webContents.send('versions:data', {
    current: activeDshVersion(),
    port: url === null ? null : new URL(url).port,
    notice,
    estimate,
    entries: entries.map((entry) => ({
      ...entry,
      installed: installed.includes(entry.version),
      diskSize: diskSizes.get(entry.version) ?? null,
    })),
  })
}

/** Push a switch-progress update to the picker window when it is open. */
function sendProgress(payload) {
  if (versionsWindow === null || versionsWindow.isDestroyed()) return
  versionsWindow.webContents.send('versions:progress', payload)
}

/**
 * Transient success toast floating over the main window (its content area is
 * covered by the dsh WebContentsView, so an in-page toast could not show).
 */
function showToast(parent, message) {
  const bounds = parent.getBounds()
  const width = 360
  const toast = new BrowserWindow({
    parent,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y + 52,
    width,
    height: 64,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
  })
  toast.setIgnoreMouseEvents(true)
  void toast.loadFile(path.join(APP_ROOT, 'pages', 'toast.html'), { query: { message } })
  toast.once('ready-to-show', () => toast.showInactive())
  // The page fades itself out at ~2.45s; close just after.
  setTimeout(() => {
    if (!toast.isDestroyed()) toast.close()
  }, 2600)
}

/** Install (if needed) + pin + in-place restart; a boot failure rolls back. */
async function switchTo(window, version, restartAndRefresh) {
  if (switching || version === activeDshVersion()) return
  switching = true
  try {
    if (!isInstalled(installedRuntimesDir(), version)) {
      sendProgress({ phase: 'download', version, percent: null })
      const log = createWriteStream(path.join(logsDir(), 'install.log'), { flags: 'a' })
      log.write(`\n===== switch ${DSH_PACKAGE}@${version} ${new Date().toISOString()} =====\n`)
      try {
        await installDsh({
          runtimesRoot: installedRuntimesDir(),
          packageName: DSH_PACKAGE,
          version,
          registry: REGISTRY,
          nodeBinDir: path.dirname(nodeBin()),
          pnpmShimDir: pnpmShimDir(),
          onOutput: (line) => {
            log.write(line)
            const percent = parsePnpmPercent(line)
            if (percent !== null) sendProgress({ phase: 'download', version, percent })
          },
        })
      } finally {
        log.end()
      }
    }
    const previous = activeDshVersion()
    sendProgress({ phase: 'starting', version })
    pinDshVersion(version)
    try {
      await restartAndRefresh()
    } catch (error) {
      // The picked version failed to boot: re-pin what worked and recover.
      if (previous !== null) {
        pinDshVersion(previous)
        await restartAndRefresh().catch(() => {})
      }
      throw error
    }
    // Success: the picker's job is done — close it and confirm via toast.
    if (versionsWindow !== null && !versionsWindow.isDestroyed()) versionsWindow.close()
    if (!window.isDestroyed()) showToast(window, `已切换到 DeepSeek Harness ${version}`)
  } catch (error) {
    sendProgress({ phase: 'error' })
    dialog.showErrorBox('切换版本失败', error instanceof Error ? error.message : String(error))
  } finally {
    switching = false
    // Refresh the badges (当前/已下载) whatever the outcome.
    void sendCatalog().catch(() => {})
  }
}
