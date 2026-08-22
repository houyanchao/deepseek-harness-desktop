/**
 * CI/build smoke of the real first-boot path, no Electron involved:
 * resolve dsh's dist-tag against the registry, install it with the staged
 * node + pnpm into a throwaway runtimes root, boot `dsh web --port 0` with a
 * throwaway DSH_HOME, wait for the URL readiness line, fetch the index, exit.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { DSH_DIST_TAG, DSH_PACKAGE, REGISTRY } from '../src/config.mjs'
import { installDsh, resolveVersion } from '../src/dsh-install.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = path.join(ROOT, 'runtime')
const NODE = path.join(RUNTIME, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

const work = mkdtempSync(path.join(tmpdir(), 'dsh-smoke-'))
const home = path.join(work, 'home')
const cleanup = () => rmSync(work, { recursive: true, force: true })

console.log(`resolve ${DSH_PACKAGE}@${DSH_DIST_TAG} via ${REGISTRY}`)
const version = await resolveVersion(REGISTRY, DSH_PACKAGE, DSH_DIST_TAG)
console.log(`install ${DSH_PACKAGE}@${version} (first-boot path)`)
const entry = await installDsh({
  runtimesRoot: path.join(work, 'runtime'),
  packageName: DSH_PACKAGE,
  version,
  registry: REGISTRY,
  nodeBinDir: path.dirname(NODE),
  pnpmShimDir: path.join(RUNTIME, 'bin'),
})

const child = spawn(NODE, [entry, 'web', '--port', '0'], {
  env: {
    ...process.env,
    DSH_HOME: home,
    PATH: [path.dirname(NODE), path.join(RUNTIME, 'bin'), process.env.PATH ?? ''].join(path.delimiter),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})

const fail = (message) => {
  console.error(`SMOKE FAIL: ${message}`)
  child.kill('SIGKILL')
  cleanup()
  process.exit(1)
}

const timeout = setTimeout(() => fail('no URL line within 90s'), 90_000)

let buffered = ''
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk)
  buffered += String(chunk)
  const match = URL_LINE.exec(buffered)
  if (match === null) return
  clearTimeout(timeout)
  const url = match[1]
  void fetch(url).then((response) => {
    if (!response.ok) return fail(`GET ${url} → ${response.status}`)
    console.log(`SMOKE OK: ${url} → ${response.status}`)
    child.kill('SIGTERM')
    child.once('exit', () => {
      cleanup()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 5_000)
  }, (error) => fail(String(error)))
})
child.on('exit', (code) => {
  if (code !== null && code !== 0) fail(`dsh web exited ${code} before serving`)
})
