/**
 * First-boot plugin preinstall. The update manifest names the plugins a fresh
 * desktop install should start with; this module decides which are actually
 * missing and installs them.
 *
 * Two rules shape the design:
 *  - install through `dsh plugin`, never pnpm directly: dsh reconciles the
 *    profile's bundle list afterwards, which is what actually activates a
 *    plugin. A bare `pnpm add` leaves it installed-but-dead.
 *  - each plugin is attempted once. A plugin the shell already installed and
 *    the user then removed must stay removed, so the per-plugin outcome is
 *    recorded rather than re-derived from the profile on every launch.
 *
 * Electron-free so the decision logic can be unit-tested.
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Give up on a plugin after this many failed attempts (transient net errors). */
export const MAX_ATTEMPTS = 3

/** A hung pnpm must not hold the splash screen hostage forever. */
const INSTALL_TIMEOUT_MS = 300_000

/**
 * Plugin names present in a profile: its dependencies plus the bundle layers
 * dsh activated from them. Reading both means a half-reconciled profile still
 * counts as "has it", so the shell never fights the user's own installs.
 * @param {string} profilePath the profile directory.
 * @returns {Promise<Set<string>>} empty when the profile has no package.json yet.
 */
export async function installedPluginNames(profilePath) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(profilePath, 'package.json'), 'utf8'))
  } catch {
    return new Set()
  }
  const bundles = manifest.dsh?.profile?.bundles
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(Array.isArray(bundles) ? bundles : []),
  ])
}

/**
 * Read the preinstall bookkeeping: `{ "<package>": { status, attempts, at } }`.
 * A missing or corrupt file reads as "nothing attempted yet".
 * @param {string} statePath
 * @returns {Promise<Record<string, { status: string, attempts?: number, at?: string }>>}
 */
export async function readPreinstallState(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    return state !== null && typeof state === 'object' ? state : {}
  } catch {
    return {}
  }
}

/** Persist the bookkeeping; best-effort, a write failure only costs a retry. */
export async function writePreinstallState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`).catch(() => {})
}

/**
 * Which of the wanted plugins to install now. Pure.
 *
 * Skipped: anything the profile already has, anything the shell has already
 * installed once (removing it afterwards is the user's call), and anything
 * that has failed too often to be worth retrying on every launch.
 *
 * @param {object} options
 * @param {{ name: string, spec: string }[]} options.desired from the manifest.
 * @param {Set<string>} options.installed from {@link installedPluginNames}.
 * @param {Record<string, { status: string, attempts?: number }>} options.state
 * @param {number} [options.maxAttempts]
 * @returns {{ name: string, spec: string }[]}
 */
export function selectMissingPlugins({ desired, installed, state, maxAttempts = MAX_ATTEMPTS }) {
  return desired.filter(({ name }) => {
    if (installed.has(name)) return false
    const record = state[name]
    if (record === undefined) return true
    if (record.status === 'installed') return false
    return (record.attempts ?? 0) < maxAttempts
  })
}

/**
 * Run `dsh plugin --profile <profile> add <spec>` with the bundled node.
 * Resolves with the exit code (-1 when it could not run at all) instead of
 * rejecting: preinstall is best-effort and the caller records the outcome.
 *
 * @param {object} options
 * @param {string} options.nodeBinPath the bundled node binary.
 * @param {string} options.dshEntryPath dsh's bin.js.
 * @param {string} options.profile profile name.
 * @param {string} options.spec package name, optionally `name@version`.
 * @param {NodeJS.ProcessEnv} options.env environment carrying DSH_HOME and PATH.
 * @param {(line: string) => void} [options.onOutput] output lines, for logging.
 * @returns {Promise<number>}
 */
export function installPlugin({ nodeBinPath, dshEntryPath, profile, spec, env, onOutput }) {
  return new Promise((resolvePromise) => {
    // Same trust posture as the dsh install itself: pnpm 10+ blocks lifecycle
    // scripts by default, which would silently break plugins that need them.
    const args = [dshEntryPath, 'plugin', '--profile', profile, 'add', spec, '--dangerously-allow-all-builds']
    const child = spawn(nodeBinPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      onOutput?.(`\n[timeout] ${spec} 安装超过 ${INSTALL_TIMEOUT_MS / 1000}s，已终止\n`)
      child.kill('SIGKILL')
    }, INSTALL_TIMEOUT_MS)
    const forward = (chunk) => onOutput?.(String(chunk))
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', (error) => {
      clearTimeout(timer)
      onOutput?.(`\n[error] ${spec}: ${error.message}\n`)
      resolvePromise(-1)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code ?? -1)
    })
  })
}
