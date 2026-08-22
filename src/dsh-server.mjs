/** Spawn and supervise the `dsh web` child process. */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { logsDir } from './paths.mjs'
import { dshEntry, dshEnv, nodeBin } from './runtime.mjs'

/** The web-app bundle prints this exact line as its readiness signal. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

const START_TIMEOUT_MS = 120_000

/**
 * Start `dsh web --port 0` (OS-assigned port) and resolve with the served URL.
 * stdout/stderr stream to userData/logs/dsh.log for post-mortem debugging.
 *
 * @param {(server: { exitCode: number | null }) => void} onExit called once when the child ends.
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export function startDshServer(onExit) {
  const entry = dshEntry()
  if (entry === null) throw new Error('没有可用的 dsh 安装 — 首次启动安装未完成')
  const logPath = path.join(logsDir(), 'dsh.log')
  const log = createWriteStream(logPath, { flags: 'a' })
  log.write(`\n===== dsh web start ${new Date().toISOString()} =====\n`)

  // --no-open: the shell embeds the GUI itself; dsh must not also hand the
  // URL to the default browser on startup.
  const child = spawn(nodeBin(), [entry, 'web', '--port', '0', '--no-open'], {
    env: dshEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.pipe(log, { end: false })

  let stopped = false
  const stop = () => new Promise((resolvePromise) => {
    stopped = true
    if (child.exitCode !== null) {
      resolvePromise()
      return
    }
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('exit', () => {
      clearTimeout(force)
      resolvePromise()
    })
    child.kill('SIGTERM')
  })

  child.on('exit', (code) => {
    log.write(`===== dsh web exit ${code} =====\n`)
    log.end()
    if (!stopped) onExit({ exitCode: code })
  })

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`dsh web printed no URL within ${START_TIMEOUT_MS / 1000}s — see ${logPath}`))
      void stop()
    }, START_TIMEOUT_MS)

    let buffered = ''
    child.stdout.on('data', (chunk) => {
      log.write(chunk)
      buffered += String(chunk)
      const match = URL_LINE.exec(buffered)
      if (match !== null) {
        clearTimeout(timeout)
        resolvePromise({ url: match[1], stop })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      rejectPromise(new Error(`dsh web exited with ${code} before serving — see ${logPath}`))
    })
  })
}

export function dshLogPath() {
  return path.join(logsDir(), 'dsh.log')
}
