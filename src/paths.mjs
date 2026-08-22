/** All filesystem locations the shell touches, resolved once at startup. */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { app } from 'electron'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The read-only staged runtime shipped with the app (node, pnpm shims, dsh seed). */
export function bundledRuntimeDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(APP_ROOT, 'runtime')
}

/** All dsh user data (profiles, sessions, credentials) lives under this DSH_HOME. */
export function dshHomeDir() {
  return path.join(app.getPath('userData'), 'dsh-home')
}

/** Upgraded dsh installs land here, one directory per version; the seed stays in resources. */
export function installedRuntimesDir() {
  return path.join(app.getPath('userData'), 'runtime')
}

export function logsDir() {
  return path.join(app.getPath('userData'), 'logs')
}

/** The web profile directory under DSH_HOME (dsh's own layout: $DSH_HOME/profiles/<name>). */
export function profileDir(profile) {
  return path.join(dshHomeDir(), 'profiles', profile)
}
