/**
 * Install dsh from the registry into a version-named directory using the
 * bundled node + pnpm. Electron-free on purpose: the shell's bootstrap and
 * the CI smoke script share this exact code path.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Path of dsh's entry inside an install directory. */
export const DSH_BIN_RELATIVE = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Marker written after a fully successful install; absence means half-installed garbage. */
const READY_MARKER = '.ready'

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
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pnpm, ['add', `${packageName}@${version}`, '--dangerously-allow-all-builds'], {
      cwd: dir,
      shell: process.platform === 'win32',
      env: { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const forward = (chunk) => onOutput?.(String(chunk))
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', rejectPromise)
    child.on('exit', (code) => resolvePromise(code ?? -1))
  })
  if (exitCode !== 0) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`dsh 安装失败（pnpm 退出码 ${exitCode}）`)
  }
  await writeFile(path.join(dir, READY_MARKER), new Date().toISOString())
  return path.join(dir, DSH_BIN_RELATIVE)
}
