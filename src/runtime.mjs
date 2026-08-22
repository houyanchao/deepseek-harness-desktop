/** Locate the bundled node/pnpm and pick the installed dsh version to boot. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { compareVersions, DSH_BIN_RELATIVE, isInstalled } from './dsh-install.mjs'
import { bundledRuntimeDir, dshHomeDir, installedRuntimesDir } from './paths.mjs'

export function nodeBin() {
  const name = process.platform === 'win32' ? 'node.exe' : 'node'
  return path.join(bundledRuntimeDir(), 'node', 'bin', name)
}

export function pnpmShimDir() {
  return path.join(bundledRuntimeDir(), 'bin')
}

export { compareVersions }

/** File beside the version directories recording the user-selected version. */
const PIN_FILE = 'current'

/** All completed dsh installs under userData/runtime, sorted old → new. */
export function installedDshVersions() {
  const root = installedRuntimesDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isInstalled(root, entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions)
}

/**
 * The version to boot: the pinned choice while its install still exists,
 * otherwise the newest install (the pre-pin behavior, so setups from before
 * the version switcher keep working unchanged).
 */
export function activeDshVersion() {
  const versions = installedDshVersions()
  const pinFile = path.join(installedRuntimesDir(), PIN_FILE)
  if (existsSync(pinFile)) {
    const pinned = readFileSync(pinFile, 'utf8').trim()
    if (versions.includes(pinned)) return pinned
  }
  return versions.at(-1) ?? null
}

/** Record the version to boot from now on; the next (re)start activates it. */
export function pinDshVersion(version) {
  writeFileSync(path.join(installedRuntimesDir(), PIN_FILE), `${version}\n`)
}

/**
 * Retention policy for version switching: installs are kept side by side so
 * switching back is instant and offline-safe, bounded to the active version
 * plus the two newest others. Anything older is deleted here (called once
 * after startup, in the background).
 */
export async function cleanupOldRuntimes() {
  const active = activeDshVersion()
  const others = installedDshVersions().reverse().filter((version) => version !== active)
  const root = installedRuntimesDir()
  await Promise.all(others.slice(2).map((version) => rm(path.join(root, version), { recursive: true, force: true })))
}

/**
 * The entry of the dsh install to boot ({@link activeDshVersion}), or null
 * when none exists yet (first boot installs one).
 */
export function dshEntry() {
  const version = activeDshVersion()
  return version === null ? null : path.join(installedRuntimesDir(), version, DSH_BIN_RELATIVE)
}

/**
 * Environment for dsh and pnpm child processes: bundled node + pnpm shims
 * prepended to PATH (dsh's plugin command resolves pnpm from PATH), and all
 * dsh user data redirected under our userData via DSH_HOME.
 */
export function dshEnv() {
  const prepend = [path.dirname(nodeBin()), pnpmShimDir()]
  return {
    ...process.env,
    PATH: [...prepend, process.env.PATH ?? ''].join(path.delimiter),
    DSH_HOME: dshHomeDir(),
  }
}
