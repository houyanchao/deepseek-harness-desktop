/**
 * The unified update manifest: one remote JSON drives both channels — the
 * shell's version (applied by downloading a new installer) and dsh's pinned
 * version (applied by the in-place pnpm installer). Electron-free so the CI
 * smoke can exercise it.
 *
 * Manifest shape (all fields optional; unknown fields ignored):
 *   {
 *     "shell": {
 *       "version": "0.2.0",
 *       "mac": "<dmg url>",            // manual download page (fallback)
 *       "win": "<setup exe url>",
 *       "macFeed": "<squirrel json url>",  // auto-update feed: JSON {"url": "<zip url>"}
 *       "winFeed": "<squirrel dir url>"    // auto-update feed: dir with RELEASES + .nupkg
 *     },
 *     "dsh": {
 *       "version": "0.1.0-rc.8",
 *       // Optional hand-curated allowlist for the version picker: only
 *       // locally-verified releases go here. Entries are a version string
 *       // or an object carrying at least { version }.
 *       "versions": ["0.1.0-rc.8", "0.1.0-rc.7"],
 *       // Optional plugins every desktop install should start with; they are
 *       // preinstalled on first boot before dsh is ever started. Entries are
 *       // a package name or { package, version }.
 *       "plugins": ["@deepseek-ai/dsh-some-plugin"]
 *     }
 *   }
 *
 * When a platform's feed is present the shell self-updates in place via
 * Electron's built-in Squirrel autoUpdater; otherwise it falls back to
 * opening the download url.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './dsh-install.mjs'

const FETCH_TIMEOUT_MS = 10_000

/**
 * Download and minimally validate the manifest. Accepts http(s) addresses
 * and, as a transition until real hosting exists, file: URLs pointing at a
 * manifest bundled with the app (Node's fetch does not speak file:).
 * @param {string} url the manifest address.
 * @returns {Promise<{ shell?: { version: string, mac?: string, win?: string }, dsh?: { version: string } }>}
 */
export async function fetchUpdateManifest(url) {
  let manifest
  if (url.startsWith('file:')) {
    manifest = JSON.parse(await readFile(fileURLToPath(url), 'utf8'))
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' })
    if (!response.ok) throw new Error(`更新清单获取失败：GET ${url} → ${response.status}`)
    manifest = await response.json()
  }
  for (const channel of ['shell', 'dsh']) {
    const entry = manifest[channel]
    if (entry !== undefined && typeof entry.version !== 'string') {
      throw new Error(`更新清单格式错误：${channel}.version 缺失或不是字符串`)
    }
  }
  const versions = manifest.dsh?.versions
  if (versions !== undefined) {
    if (!Array.isArray(versions)) throw new Error('更新清单格式错误：dsh.versions 不是数组')
    for (const entry of versions) {
      const valid = typeof entry === 'string'
        || (entry !== null && typeof entry === 'object' && typeof entry.version === 'string')
      if (!valid) throw new Error('更新清单格式错误：dsh.versions 的项需为版本字符串或含 version 字段的对象')
    }
  }
  const plugins = manifest.dsh?.plugins
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) throw new Error('更新清单格式错误：dsh.plugins 不是数组')
    for (const entry of plugins) {
      const valid = (typeof entry === 'string' && entry !== '')
        || (entry !== null && typeof entry === 'object' && typeof entry.package === 'string' && entry.package !== ''
          && (entry.version === undefined || typeof entry.version === 'string'))
      if (!valid) throw new Error('更新清单格式错误：dsh.plugins 的项需为包名字符串或含 package（及可选字符串 version）的对象')
    }
  }
  return manifest
}

/**
 * The hand-curated dsh version allowlist for the picker, or null when the
 * manifest does not curate (no dsh.versions field) — callers then fall back
 * to the registry list. Object entries are accepted so a manifest may carry
 * per-version bookkeeping of its own; only the version is read.
 * @param {object} manifest a validated manifest.
 * @returns {string[] | null}
 */
export function curatedDshVersions(manifest) {
  const list = manifest.dsh?.versions
  if (list === undefined) return null
  return list.map((entry) => (typeof entry === 'string' ? entry : entry.version))
}

/**
 * The plugins a fresh install should start with. Name and install spec are
 * kept apart on purpose: presence is checked by package name, and deriving one
 * from a `pkg@version` spec is ambiguous for scoped packages.
 * @param {object} manifest a validated manifest.
 * @returns {{ name: string, spec: string }[]}
 */
export function curatedPlugins(manifest) {
  const list = manifest.dsh?.plugins
  if (list === undefined) return []
  return list.map((entry) => {
    if (typeof entry === 'string') return { name: entry, spec: entry }
    const spec = typeof entry.version === 'string' ? `${entry.package}@${entry.version}` : entry.package
    return { name: entry.package, spec }
  })
}

/**
 * Decide what to update, given the manifest and what is currently running.
 * Pure so it can be unit-tested without network or Electron.
 *
 * @param {object} manifest a validated manifest.
 * @param {{ shellVersion: string, dshVersion: string | null, platform: string }} current
 * @returns {{ shell: { version: string, url: string | undefined, feed: string | undefined } | null, dsh: { version: string } | null }}
 */
export function planUpdates(manifest, { shellVersion, dshVersion, platform }) {
  let shell = null
  if (manifest.shell !== undefined && compareVersions(manifest.shell.version, shellVersion) > 0) {
    shell = {
      version: manifest.shell.version,
      url: platform === 'win32' ? manifest.shell.win : manifest.shell.mac,
      feed: platform === 'win32' ? manifest.shell.winFeed : manifest.shell.macFeed,
    }
  }
  let dsh = null
  if (manifest.dsh !== undefined && (dshVersion === null || compareVersions(manifest.dsh.version, dshVersion) > 0)) {
    dsh = { version: manifest.dsh.version }
  }
  return { shell, dsh }
}
