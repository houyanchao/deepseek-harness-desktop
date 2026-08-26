/** Spawn and supervise the `dsh web` child process. */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { DETACHED, killTree } from './child.mjs'
import { logsDir } from './paths.mjs'
import { dshEntry, dshEnv, nodeBin } from './runtime.mjs'

/** The web-app bundle prints this exact line as its readiness signal. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

const START_TIMEOUT_MS = 120_000

/** How long a stop waits for the tree to go down on its own before forcing it. */
const STOP_GRACE_MS = 5_000

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
    // Own process group, so stopping reaches whatever dsh spawned (killTree).
    detached: DETACHED,
  })
  child.stderr.pipe(log, { end: false })

  let stopped = false
  const stop = () => new Promise((resolvePromise) => {
    stopped = true
    if (child.exitCode !== null) {
      resolvePromise()
      return
    }
    const force = setTimeout(() => killTree(child, 'SIGKILL'), STOP_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(force)
      resolvePromise()
    })
    killTree(child, 'SIGTERM')
  })

  return new Promise((resolvePromise, rejectPromise) => {
    // Decides which half of the lifecycle an exit belongs to: before the URL
    // it is a failed start (this promise rejects and the caller reports it),
    // after it a crash the supervisor should restart. Routing an exit to both
    // would race the caller's error path against the restart loop.
    let serving = false
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`dsh web printed no URL within ${START_TIMEOUT_MS / 1000}s — see ${logPath}`))
      void stop()
    }, START_TIMEOUT_MS)

    let buffered = ''
    child.stdout.on('data', (chunk) => {
      log.write(chunk)
      // Only the startup banner is scanned. dsh keeps logging for as long as
      // the app runs, so accumulating past readiness would grow a buffer for
      // hours and re-run the regex over all of it on every chunk.
      if (serving) return
      buffered += String(chunk)
      const match = URL_LINE.exec(buffered)
      if (match === null) return
      serving = true
      buffered = ''
      clearTimeout(timeout)
      resolvePromise({ url: match[1], stop })
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      if (!serving) rejectPromise(error)
    })

    child.on('exit', (code) => {
      log.write(`===== dsh web exit ${code} =====\n`)
      log.end()
      clearTimeout(timeout)
      if (!serving) {
        rejectPromise(new Error(`dsh web exited with ${code} before serving — see ${logPath}`))
        return
      }
      if (!stopped) onExit({ exitCode: code })
    })
  })
}

export function dshLogPath() {
  return path.join(logsDir(), 'dsh.log')
}
