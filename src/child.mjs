/**
 * Child-process helpers shared by the dsh server and the pnpm-backed
 * installers. Electron-free on purpose: the CI smoke script drives the same
 * install path.
 */

import { spawn } from 'node:child_process'

/**
 * POSIX children are spawned into their own process group so a stop can reach
 * the whole tree. Windows has no process groups — and `detached` there also
 * pops a console window — so children stay attached and taskkill walks the
 * tree instead.
 */
export const DETACHED = process.platform !== 'win32'

/**
 * Terminate a child *and everything it spawned*. dsh runs pnpm, and pnpm runs
 * node: signalling the direct child alone leaves those grandchildren behind
 * holding the port and the store lock.
 *
 * @param {import('node:child_process').ChildProcess} child spawned with `detached: DETACHED`.
 * @param {'SIGTERM' | 'SIGKILL'} signal SIGTERM asks, SIGKILL forces.
 */
export function killTree(child, signal) {
  if (child.pid === undefined || child.exitCode !== null) return
  // Windows has no graceful tree signal: the asking pass reaches the child
  // alone, and the forcing pass hands the whole tree to taskkill.
  if (process.platform === 'win32' && signal === 'SIGTERM') child.kill()
  else killTreeByPid(child.pid, signal)
}

/**
 * Terminate a process tree by pid alone — the orphan case, where the run that
 * spawned it is gone and no ChildProcess handle survives to signal.
 *
 * @param {number} pid the group leader (POSIX) or tree root (Windows).
 * @param {'SIGTERM' | 'SIGKILL'} signal SIGTERM asks, SIGKILL forces.
 */
export function killTreeByPid(pid, signal) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone (or the process was never detached); the
    // process itself is the best that can still be reached.
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited between the check and the signal.
    }
  }
}
