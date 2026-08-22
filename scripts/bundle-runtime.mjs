/**
 * Stage the bundled runtime under ./runtime for the current (or given)
 * platform: a stripped Node and a pnpm dist with shims. dsh itself is NOT
 * bundled — the shell installs it from the registry on first boot, keeping
 * shell releases and dsh releases fully independent. Forge picks the
 * directory up as an extraResource.
 *
 *   node scripts/bundle-runtime.mjs [--platform darwin|win32] [--arch arm64|x64]
 *
 * Environment overrides:
 *   NODE_MIRROR           node dist mirror (default: npmmirror's node mirror)
 *   DSH_DESKTOP_REGISTRY  registry for the pnpm download
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NODE_VERSION, PNPM_VERSION, REGISTRY } from '../src/config.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = path.join(ROOT, 'runtime')
const WORK = path.join(RUNTIME, '.work')

const NODE_MIRROR = process.env.NODE_MIRROR ?? 'https://npmmirror.com/mirrors/node'

function parseArgs() {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  return {
    platform: value('--platform') ?? process.platform,
    arch: value('--arch') ?? process.arch,
  }
}

async function download(url, dest) {
  console.log(`download ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

/** Extract an archive with the system tar (bsdtar handles .tar.gz, .tgz and .zip on mac and win10+). */
function extract(archive, dest, stripComponents = 0) {
  const args = ['-x', '-f', archive, '-C', dest]
  if (stripComponents > 0) args.push(`--strip-components=${stripComponents}`)
  const result = spawnSync('tar', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`tar failed on ${archive}`)
}

/** Bundle only the node executable — the dist's npm/corepack/docs are dead weight. */
async function stageNode(platform, arch) {
  const nodeDir = path.join(RUNTIME, 'node', 'bin')
  await mkdir(nodeDir, { recursive: true })
  const base = `node-v${NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`
  if (platform === 'win32') {
    const archive = path.join(WORK, `${base}.zip`)
    await download(`${NODE_MIRROR}/v${NODE_VERSION}/${base}.zip`, archive)
    const unpacked = path.join(WORK, 'node-unpacked')
    await mkdir(unpacked, { recursive: true })
    extract(archive, unpacked)
    await cp(path.join(unpacked, base, 'node.exe'), path.join(nodeDir, 'node.exe'))
  } else {
    const archive = path.join(WORK, `${base}.tar.gz`)
    await download(`${NODE_MIRROR}/v${NODE_VERSION}/${base}.tar.gz`, archive)
    const unpacked = path.join(WORK, 'node-unpacked')
    await mkdir(unpacked, { recursive: true })
    extract(archive, unpacked, 1)
    await cp(path.join(unpacked, 'bin', 'node'), path.join(nodeDir, 'node'))
    await chmod(path.join(nodeDir, 'node'), 0o755)
  }
  return nodeDir
}

/** pnpm is platform-independent JS; ship the package plus tiny shims that pin our node. */
async function stagePnpm() {
  const pnpmDir = path.join(RUNTIME, 'pnpm')
  const archive = path.join(WORK, 'pnpm.tgz')
  await download(`${REGISTRY}/pnpm/-/pnpm-${PNPM_VERSION}.tgz`, archive)
  await mkdir(pnpmDir, { recursive: true })
  extract(archive, pnpmDir, 1)

  const shimDir = path.join(RUNTIME, 'bin')
  await mkdir(shimDir, { recursive: true })
  // POSIX shim: resolve our sibling node so pnpm never depends on a system node.
  await writeFile(path.join(shimDir, 'pnpm'), [
    '#!/bin/sh',
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    'exec "$DIR/../node/bin/node" "$DIR/../pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
  // Windows shim: dsh spawns pnpm with shell:true, which resolves pnpm.cmd.
  await writeFile(path.join(shimDir, 'pnpm.cmd'), [
    '@echo off',
    '"%~dp0..\\node\\bin\\node.exe" "%~dp0..\\pnpm\\bin\\pnpm.cjs" %*',
    '',
  ].join('\r\n'))
  return shimDir
}

async function main() {
  const { platform, arch } = parseArgs()
  console.log(`staging runtime for ${platform}-${arch}`)
  await rm(RUNTIME, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  await stageNode(platform, arch)
  await stagePnpm()

  await writeFile(path.join(RUNTIME, 'manifest.json'), JSON.stringify({
    platform,
    arch,
    node: NODE_VERSION,
    pnpm: PNPM_VERSION,
    stagedAt: new Date().toISOString(),
  }, null, 2))
  await rm(WORK, { recursive: true, force: true })
  console.log('runtime staged at', RUNTIME)
}

await main()
