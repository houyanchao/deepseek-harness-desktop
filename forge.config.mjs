import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = path.join(ROOT, 'runtime')

if (!existsSync(path.join(RUNTIME_DIR, 'manifest.json'))) {
  throw new Error('runtime staging missing — run `pnpm run bundle-runtime` before packaging')
}

export default {
  packagerConfig: {
    name: 'DSH',
    // Also the binary name: packager derives CFBundleDisplayName (Dock
    // tooltip, Force Quit list) from it, so it must not stay internal-looking.
    // The userData directory is pinned separately (config.mjs), so renaming
    // never orphans existing user data.
    executableName: 'DSH',
    appBundleId: 'com.dsh-desktop.app',
    // Extension-less on purpose: packager appends .icns / .ico per platform.
    // Regenerate both from assets/icon.svg via `pnpm run build-icons`.
    icon: path.join(ROOT, 'assets', 'icon'),
    asar: true,
    // The bundled Node, pnpm, and the dsh seed tree live outside the asar so
    // they can be executed directly from Contents/Resources/runtime.
    extraResource: [RUNTIME_DIR],
    // TODO(signing): osxSign / osxNotarize go here once a Developer ID
    // certificate is available; unsigned builds only run on the build machine.
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { icon: path.join(ROOT, 'assets', 'icon.icns') },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        setupExe: 'DSH-Setup.exe',
        setupIcon: path.join(ROOT, 'assets', 'icon.ico'),
      },
    },
  ],
}
