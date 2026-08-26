/**
 * Install dsh from the registry into a version-named directory using the
 * bundled node + pnpm. Electron-free on purpose: the shell's bootstrap and
 * the CI smoke script share this exact code path.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DETACHED, killTree } from './child.mjs'

/** Path of dsh's entry inside an install directory. */
export const DSH_BIN_RELATIVE = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Marker written after a fully successful install; absence means half-installed garbage. */
const READY_MARKER = '.ready'

/**
 * Abandon an install that has gone quiet for this long. Deliberately an idle
 * timeout rather than a total one: pnpm streams progress lines throughout, so
 * silence means wedged (a dead mirror connection that never times out), while
 * a slow-but-working download of a few hundred MB must not be cut off.
 */
const IDLE_TIMEOUT_MS = 180_000

/**
 * Whether a value is shaped like a version we could have installed:
 * `major.minor.patch` with an optional prerelease tail. Every install lives at
 * `<runtimesRoot>/<version>`, so this is the gate for version strings that
 * arrive from outside (IPC) before they are joined into a path or handed to
 * pnpm — path separators and `..` segments never pass.
 */
export function isVersionName(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

/** Compare dotted prerelease versions ("0.1.0-rc.7"); release > its prereleases. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-')
    return { core: core.split('.').map(Number), pre }
  }
  const va = parse(a)
  const vb = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const diff = (va.core[index] ?? 0) - (vb.core[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (va.pre === vb.pre) return 0
  if (va.pre === undefined) return 1
  if (vb.pre === undefined) return -1
  return va.pre.localeCompare(vb.pre, undefined, { numeric: true })
}

/**
 * Resolve a dist-tag to a concrete version via the registry.
 * @returns {Promise<string>} e.g. "0.1.0-rc.7".
 */
export async function resolveVersion(registry, packageName, distTag = 'latest') {
  const url = `${registry}/${packageName.replace('/', '%2F')}/${distTag}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`版本查询失败：GET ${url} → ${response.status}`)
  const metadata = await response.json()
  if (typeof metadata.version !== 'string') throw new Error(`版本查询失败：${url} 未返回 version`)
  return metadata.version
}

/**
 * Fetch the published-version catalog of a package: full registry metadata,
 * one entry per version with its release date. Bounded by a timeout: callers
 * use this to populate an interactive picker and degrade to downloaded-only
 * when the registry is slow or unreachable.
 * @returns {Promise<Array<{ version: string, publishedAt: string | null }>>}
 */
export async function fetchVersionCatalog(registry, packageName, timeoutMs = 10_000) {
  const url = `${registry}/${packageName.replace('/', '%2F')}`
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`版本列表查询失败：GET ${url} → ${response.status}`)
  const metadata = await response.json()
  // Deliberately no dist.unpackedSize: it covers the dsh package alone
  // (~100 KB) while a real install with dependencies runs hundreds of MB —
  // honest sizes come from measuring installed directories instead.
  return Object.values(metadata.versions ?? {}).map((entry) => ({
    version: entry.version,
    publishedAt: metadata.time?.[entry.version] ?? null,
  }))
}

/**
 * Extract an install percentage from pnpm's progress reporter lines
 * ("Progress: resolved N, reused N, downloaded N, added N"), or null when a
 * chunk carries none — callers then keep whatever they were showing.
 * Capped below 100 so the bar never claims completion before pnpm exits.
 */
export function parsePnpmPercent(chunk) {
  const matches = chunk.match(/resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/g)
  if (matches === null) return null
  const [, resolved, reused, downloaded, added] = /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/
    .exec(matches[matches.length - 1])
    .map(Number)
  if (resolved === 0) return null
  return Math.min(99, Math.round((Math.max(reused + downloaded, added) / resolved) * 100))
}

/** On-disk size marker, written beside .ready after the first measurement. */
const SIZE_MARKER = '.size'

/**
 * Actual on-disk size of an installed version in bytes: measured by walking
 * the directory once, then cached in a marker file (installs are immutable
 * after .ready, so the number never goes stale).
 */
export async function installedSize(runtimesRoot, version) {
  const dir = path.join(runtimesRoot, version)
  const marker = path.join(dir, SIZE_MARKER)
  try {
    const cached = Number(await readFile(marker, 'utf8'))
    if (Number.isFinite(cached) && cached > 0) return cached
  } catch {
    // First measurement below.
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  let total = 0
  const BATCH = 512
  for (let index = 0; index < files.length; index += BATCH) {
    const sizes = await Promise.all(files.slice(index, index + BATCH).map(async (entry) => {
      try {
        return (await stat(path.join(entry.parentPath, entry.name))).size
      } catch {
        return 0
      }
    }))
    for (const size of sizes) total += size
  }
  await writeFile(marker, String(total)).catch(() => {})
  return total
}

/** Whether a completed install of this version exists under the runtimes root. */
export function isInstalled(runtimesRoot, version) {
  const dir = path.join(runtimesRoot, version)
  return existsSync(path.join(dir, READY_MARKER)) && existsSync(path.join(dir, DSH_BIN_RELATIVE))
}

/**
 * Install `packageName@version` into `<runtimesRoot>/<version>` with the
 * bundled pnpm. Idempotent: a ready install returns immediately; a leftover
 * half-install is wiped and redone. Rejects on any failure (network, registry,
 * pnpm) after cleaning up, so a retry on next launch starts fresh.
 *
 * @param {object} options
 * @param {string} options.runtimesRoot userData/runtime.
 * @param {string} options.packageName the dsh package.
 * @param {string} options.version concrete version (from {@link resolveVersion}).
 * @param {string} options.registry registry base URL.
 * @param {string} options.nodeBinDir directory of the bundled node binary.
 * @param {string} options.pnpmShimDir directory of the bundled pnpm shims.
 * @param {(line: string) => void} [options.onOutput] pnpm output lines, for logging.
 */
export async function installDsh({ runtimesRoot, packageName, version, registry, nodeBinDir, pnpmShimDir, onOutput }) {
  if (isInstalled(runtimesRoot, version)) return path.join(runtimesRoot, version, DSH_BIN_RELATIVE)
  const dir = path.join(runtimesRoot, version)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-runtime', private: true }, null, 2))
  // hoisted: no symlinks, and the tree keeps working if pnpm's store moves.
  await writeFile(path.join(dir, '.npmrc'), `registry=${registry}\nnode-linker=hoisted\n`)

  const pnpm = path.join(pnpmShimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  let timedOut = false
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pnpm, ['add', `${packageName}@${version}`, '--dangerously-allow-all-builds'], {
      cwd: dir,
      shell: process.platform === 'win32',
      env: { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: pnpm spawns node for lifecycle scripts, and the
      // idle timeout below has to take those down with it.
      detached: DETACHED,
    })
    // A wedged pnpm would otherwise hold the splash screen forever, with no
    // way out but force-quitting the app.
    let idle = null
    const armIdleTimer = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        timedOut = true
        onOutput?.(`\n[timeout] pnpm 静默超过 ${IDLE_TIMEOUT_MS / 1000}s，已终止\n`)
        killTree(child, 'SIGKILL')
      }, IDLE_TIMEOUT_MS)
    }
    const forward = (chunk) => {
      armIdleTimer()
      onOutput?.(String(chunk))
    }
    armIdleTimer()
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', (error) => {
      clearTimeout(idle)
      rejectPromise(error)
    })
    child.on('exit', (code) => {
      clearTimeout(idle)
      resolvePromise(code ?? -1)
    })
  })
  if (exitCode !== 0) {
    await rm(dir, { recursive: true, force: true })
    if (timedOut) throw new Error(`dsh 安装超时：pnpm 静默超过 ${IDLE_TIMEOUT_MS / 1000}s，请检查网络后重试`)
    throw new Error(`dsh 安装失败（pnpm 退出码 ${exitCode}）`)
  }
  await writeFile(path.join(dir, READY_MARKER), new Date().toISOString())
  return path.join(dir, DSH_BIN_RELATIVE)
}
