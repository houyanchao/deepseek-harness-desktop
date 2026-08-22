/** First-boot preparation: DSH_HOME layout, dsh install, plugin preinstall. */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { DSH_DIST_TAG, DSH_PACKAGE, PROFILE, REGISTRY, UPDATE_MANIFEST_URL } from './config.mjs'
import { installDsh, resolveVersion } from './dsh-install.mjs'
import {
  installPlugin,
  installedPluginNames,
  readPreinstallState,
  selectMissingPlugins,
  writePreinstallState,
} from './plugins.mjs'
import { curatedPlugins, fetchUpdateManifest } from './update-manifest.mjs'
import { dshHomeDir, installedRuntimesDir, logsDir, profileDir } from './paths.mjs'
import { dshEntry, dshEnv, nodeBin, pnpmShimDir } from './runtime.mjs'

/**
 * Idempotent directory + registry setup. The profile .npmrc is written before
 * dsh ever initializes the profile, so the very first plugin install already
 * goes through the configured registry.
 */
export async function prepareHome() {
  const profile = profileDir(PROFILE)
  await mkdir(profile, { recursive: true })
  await mkdir(logsDir(), { recursive: true })
  const npmrc = path.join(profile, '.npmrc')
  if (!existsSync(npmrc)) await writeFile(npmrc, `registry=${REGISTRY}\n`)
}

/**
 * Make sure a dsh install exists: boot the newest installed version, or on
 * first launch resolve the dist-tag against the registry and install it into
 * userData/runtime/<version>. Install output streams to logs/install.log.
 * Throws when there is no install and the download fails (no network) — the
 * caller surfaces that as a fatal first-boot error.
 * @param {(status: string) => void} onStatus splash status callback.
 * @returns {Promise<string>} the dsh entry path.
 */
export async function ensureDsh(onStatus) {
  const existing = dshEntry()
  if (existing !== null) return existing
  onStatus('正在获取 DeepSeek Harness 版本…')
  // The manifest (when configured and reachable) pins the version; otherwise
  // the registry dist-tag decides. First boot must not fail just because the
  // manifest host is down while the registry is fine.
  let version = null
  if (UPDATE_MANIFEST_URL !== null) {
    try {
      version = (await fetchUpdateManifest(UPDATE_MANIFEST_URL)).dsh?.version ?? null
    } catch {
      version = null
    }
  }
  version ??= await resolveVersion(REGISTRY, DSH_PACKAGE, DSH_DIST_TAG)
  onStatus(`正在下载 DeepSeek Harness ${version}…`)
  const log = createWriteStream(path.join(logsDir(), 'install.log'), { flags: 'a' })
  log.write(`\n===== install ${DSH_PACKAGE}@${version} ${new Date().toISOString()} =====\n`)
  try {
    return await installDsh({
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
}

/**
 * Install the manifest's plugin set into the profile before dsh first starts,
 * so a fresh install opens with them already there. Runs before every dsh
 * start but does work only while something is genuinely missing: plugins the
 * profile already has, and plugins this shell has already installed once
 * (whatever the user did with them since), are left alone.
 *
 * Best-effort throughout — no manifest, no network, or a failing install must
 * not keep the app from opening; a failure is retried on the next few
 * launches and then dropped.
 *
 * @param {(status: string) => void} onStatus splash status callback.
 */
export async function preinstallPlugins(onStatus) {
  if (UPDATE_MANIFEST_URL === null) return
  const entry = dshEntry()
  if (entry === null) return

  let desired = []
  try {
    desired = curatedPlugins(await fetchUpdateManifest(UPDATE_MANIFEST_URL))
  } catch {
    return
  }
  if (desired.length === 0) return

  const statePath = path.join(dshHomeDir(), '.preinstalled-plugins.json')
  const state = await readPreinstallState(statePath)
  const installed = await installedPluginNames(profileDir(PROFILE))
  const missing = selectMissingPlugins({ desired, installed, state })
  if (missing.length === 0) return

  const log = createWriteStream(path.join(logsDir(), 'install.log'), { flags: 'a' })
  log.write(`\n===== preinstall plugins ${new Date().toISOString()} =====\n`)
  try {
    for (const [index, plugin] of missing.entries()) {
      const counter = missing.length > 1 ? `（${index + 1}/${missing.length}）` : ''
      onStatus(`正在安装插件${counter}：${plugin.name}…`)
      log.write(`\n--- ${plugin.spec} ---\n`)
      const exitCode = await installPlugin({
        nodeBinPath: nodeBin(),
        dshEntryPath: entry,
        profile: PROFILE,
        spec: plugin.spec,
        env: dshEnv(),
        onOutput: (line) => log.write(line),
      })
      const attempts = (state[plugin.name]?.attempts ?? 0) + 1
      state[plugin.name] = exitCode === 0
        ? { status: 'installed', attempts, at: new Date().toISOString() }
        : { status: 'failed', attempts, at: new Date().toISOString(), exitCode }
      if (exitCode !== 0) {
        console.warn(`plugin preinstall failed: ${plugin.spec} (exit ${exitCode}, attempt ${attempts})`)
      }
    }
  } finally {
    await writePreinstallState(statePath, state)
    log.end()
  }
}

/** Pin userData to a stable directory name, independent of the display name. */
export function pinUserDataDir(dirName) {
  app.setPath('userData', path.join(app.getPath('appData'), dirName))
}
