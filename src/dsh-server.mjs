/** Spawn and supervise the `dsh web` child process. */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { DETACHED, killTree, killTreeByPid } from './child.mjs'
import { logsDir, serverRecordPath } from './paths.mjs'
import { dshEntry, dshEnv, nodeBin } from './runtime.mjs'

/** The web-app bundle prints this exact line as its readiness signal. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

const START_TIMEOUT_MS = 120_000

/** How long a stop waits for the tree to go down on its own before forcing it. */
const STOP_GRACE_MS = 5_000

/**
 * Preferred port for the dsh GUI. The browser side keys localStorage and
 * friends by origin, so a stable port keeps that data alive across restarts
 * and version switches; a random port would silently "lose" it every launch.
 * Unassigned by IANA and below the ephemeral range (49152+), so collisions
 * with other software are unlikely — and never fatal (see pickPort).
 */
const PREFERRED_PORT = 41729

/** The port served by the previous (or current) run; reused on restarts. */
let lastPort = null

/** How long an orphan gets to release the socket before the port is given up. */
const RECLAIM_TIMEOUT_MS = 3_000

const RECLAIM_POLL_MS = 100

/** Whether nothing else currently listens on the port (loopback probe). */
function portFree(port) {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.once('error', () => resolvePromise(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)))
  })
}

/** Record which child serves which port, for the next run to recognize. */
function writeServerRecord(pid, port) {
  const file = serverRecordPath()
  const temp = `${file}.tmp`
  try {
    writeFileSync(temp, JSON.stringify({ pid, port }))
    renameSync(temp, file)
  } catch {
    // Best-effort bookkeeping: failing to record only costs the preferred
    // port after a crash, never this run.
    rmSync(temp, { force: true })
  }
}

function readServerRecord() {
  try {
    const record = JSON.parse(readFileSync(serverRecordPath(), 'utf8'))
    return typeof record.pid === 'number' && typeof record.port === 'number' ? record : null
  } catch {
    return null
  }
}

/** The full command line of a live process, or null when it is gone. */
function commandLineOf(pid) {
  const [command, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
    : ['ps', ['-o', 'command=', '-p', String(pid)]]
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.trim() === '' ? null : output
  } catch {
    // Non-zero exit means no such process; a missing tool means we cannot
    // prove ownership. Either way the port is left to its holder.
    return null
  }
}

/**
 * Take the port back from this app's own leftover child. A crash or a
 * force-quit never runs `stop`, and the detached child keeps serving — and
 * keeps the port. Quietly moving to another port would strand the browser
 * storage keyed to the old origin, so the orphan is taken down instead.
 *
 * Ownership must be proven twice — the recorded pid is still alive *and* is
 * still running this app's own runtime as `dsh web` — so a pid the OS has
 * since recycled into an unrelated program is never touched.
 *
 * @returns {Promise<boolean>} true once the port is free again.
 */
async function reclaimPort(port) {
  const record = readServerRecord()
  if (record === null || record.port !== port) return false
  const commandLine = commandLineOf(record.pid)
  if (commandLine === null || !commandLine.includes(nodeBin()) || !commandLine.includes(' web ')) return false

  killTreeByPid(record.pid, 'SIGTERM')
  // The socket closes as the tree unwinds, which no event here observes.
  for (let waited = 0; waited < RECLAIM_TIMEOUT_MS; waited += RECLAIM_POLL_MS) {
    if (await portFree(port)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, RECLAIM_POLL_MS))
  }
  killTreeByPid(record.pid, 'SIGKILL')
  return portFree(port)
}

/** The port to ask for: last used → preferred → 0 (OS-assigned). */
async function pickPort() {
  const wanted = lastPort ?? PREFERRED_PORT
  if (await portFree(wanted)) return wanted
  return (await reclaimPort(wanted)) ? wanted : 0
}

/**
 * Start `dsh web` and resolve with the served URL. Prefers a stable port
 * (see PREFERRED_PORT), falling back to an OS-assigned one when it is taken.
 * stdout/stderr stream to userData/logs/dsh.log for post-mortem debugging.
 *
 * @param {(server: { exitCode: number | null }) => void} onExit called once when the child ends.
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export async function startDshServer(onExit) {
  const entry = dshEntry()
  if (entry === null) throw new Error('没有可用的 dsh 安装 — 首次启动安装未完成')
  const port = await pickPort()
  try {
    return await attemptStart(entry, port, onExit)
  } catch (error) {
    // The probe and the child's bind race by nature (another process can grab
    // the port in between). A fixed-port failure is retried once on an
    // OS-assigned port before the error reaches the caller.
    if (port === 0) throw error
    return attemptStart(entry, 0, onExit)
  }
}

/** One spawn attempt on one port; rejects when the child dies before serving. */
function attemptStart(entry, port, onExit) {
  const logPath = path.join(logsDir(), 'dsh.log')
  const log = createWriteStream(logPath, { flags: 'a' })
  log.write(`\n===== dsh web start ${new Date().toISOString()} =====\n`)

  // --no-open: the shell embeds the GUI itself; dsh must not also hand the
  // URL to the default browser on startup.
  const child = spawn(nodeBin(), [entry, 'web', '--port', String(port), '--no-open'], {
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
      // Nothing holds the port any more; leaving the record would point the
      // next start at a pid it has no business signalling.
      rmSync(serverRecordPath(), { force: true })
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
      // Remember the served port (also when OS-assigned): the next start —
      // restart, version switch, crash recovery — reuses it, keeping the
      // origin and its browser-side storage stable.
      lastPort = Number(new URL(match[1]).port)
      writeServerRecord(child.pid, lastPort)
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
