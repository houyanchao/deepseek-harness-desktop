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
  if (process.platform === 'win32') {
    // Windows has no graceful tree signal: the asking pass reaches the child
    // alone, and the forcing pass hands the whole tree to taskkill.
    if (signal === 'SIGTERM') child.kill()
    else spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone (or the child was never detached); the direct
    // child is the best that can still be reached.
    child.kill(signal)
  }
}
