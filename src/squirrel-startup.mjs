/**
 * Squirrel.Windows install-time events. Setup.exe (and Update.exe during an
 * auto-update) relaunches the app with a --squirrel-* flag, expecting it to
 * manage its Start-menu/desktop shortcuts and exit immediately — reaching the
 * normal boot path from such a launch would flash the app mid-install.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

/**
 * Handle a Squirrel event launch, if this is one.
 * @returns {boolean} true when the app is quitting and boot must be skipped.
 */
export function handleSquirrelStartup() {
  if (process.platform !== 'win32') return false
  const event = process.argv[1]
  if (typeof event !== 'string' || !event.startsWith('--squirrel-')) return false
  // Squirrel's layout: <root>/Update.exe above the versioned app-* directory
  // that holds this executable.
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
  const exeName = path.basename(process.execPath)
  if (event === '--squirrel-install' || event === '--squirrel-updated') {
    spawn(updateExe, [`--createShortcut=${exeName}`], { detached: true, stdio: 'ignore' }).unref()
  } else if (event === '--squirrel-uninstall') {
    spawn(updateExe, [`--removeShortcut=${exeName}`], { detached: true, stdio: 'ignore' }).unref()
  }
  // --squirrel-obsolete (and anything unknown) needs no work: just exit fast.
  app.quit()
  return true
}
