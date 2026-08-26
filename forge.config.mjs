import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const OUT_DIR = path.join(ROOT, 'out')
const MAKE_DIR = path.join(OUT_DIR, 'make')

const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/** Shared stem of every distributable: `DSH_<version>_<platform>_<arch>`. */
const ARTIFACT_STEM = 'DSH'

/**
 * `electron-forge package` writes an unpacked app next to `out/make`
 * (`DSH-darwin-arm64/`, `DSH-win32-x64/`, …). That tree is
 * only an input to the makers — not an installer — and is ~the same size as
 * the dmg/exe. Drop it (and leftover dirs from older product names) once
 * make has finished so `out/` only keeps distributable artifacts.
 */
function cleanUnpackagedOutput() {
  if (!existsSync(OUT_DIR)) return
  for (const name of readdirSync(OUT_DIR)) {
    if (name === 'make') continue
    rmSync(path.join(OUT_DIR, name), { recursive: true, force: true })
  }
}

/** Delete directories that the artifact move left behind, deepest first. */
function pruneEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name)
    if (!statSync(child).isDirectory()) continue
    pruneEmptyDirs(child)
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true })
  }
}

/**
 * Squirrel.Windows writes these names into its update feed and looks them up
 * verbatim, so they are the one thing that must keep the maker's own naming.
 */
const SQUIRREL_FEED_FILE = /^RELEASES$|\.nupkg$/

/** `DSH_0.1.0_darwin_arm64.dmg` — one rule for every installer. */
function artifactName(artifact, platform, arch) {
  const base = path.basename(artifact)
  if (SQUIRREL_FEED_FILE.test(base)) return base
  return `${ARTIFACT_STEM}_${VERSION}_${platform}_${arch}${path.extname(base)}`
}

/**
 * Every maker nests its output differently (`make/zip/<platform>/<arch>/`,
 * `make/squirrel.windows/<arch>/`, while the dmg lands in `make/` itself) and
 * names its files its own way. Collect everything into `make/<version>/` under
 * one naming rule, so a release is one folder whose contents read as a set,
 * and hand the new paths back so Forge reports where things actually are.
 */
function collectArtifacts(makeResults) {
  const releaseDir = path.join(MAKE_DIR, VERSION)
  mkdirSync(releaseDir, { recursive: true })
  const collected = makeResults.map(result => ({
    ...result,
    artifacts: result.artifacts.map((artifact) => {
      const target = path.join(releaseDir, artifactName(artifact, result.platform, result.arch))
      if (artifact === target) return artifact
      renameSync(artifact, target)
      return target
    }),
  }))
  pruneEmptyDirs(MAKE_DIR)
  return collected
}

if (!existsSync(path.join(RUNTIME_DIR, 'manifest.json'))) {
  throw new Error('runtime staging missing — run `pnpm run bundle-runtime` before packaging')
}

const packagerConfig = {
  // Deliberately not "DSH Desktop": that is the official DeepSeek client's
  // name, and two identically named .app bundles in /Applications collide.
  name: 'DSH',
  // Also the binary name: packager derives CFBundleDisplayName (Dock
  // tooltip, Force Quit list) from it, so it must not stay internal-looking.
  // The userData directory is pinned separately (config.mjs), so renaming
  // never orphans existing user data.
  executableName: 'DSH',
  // Reverse-DNS under a domain we actually control (the GitHub Pages host of
  // the repo owner), so it can never collide with the official client's id.
  appBundleId: 'io.github.houyanchao.dsh',
  // Extension-less on purpose: packager appends .icns / .ico per platform.
  // Regenerate both from assets/icon.svg via `pnpm run build-icons`.
  icon: path.join(ROOT, 'assets', 'icon'),
  asar: true,
  // The bundled Node, pnpm, and the dsh seed tree live outside the asar so
  // they can be executed directly from Contents/Resources/runtime.
  extraResource: [RUNTIME_DIR],
  // Array (not a function) so these stack with packager's default ignores.
  // gitignore does not stop Forge from copying a cert into the user's .app.
  ignore: [
    '\\.p12$',
    '\\.p8$',
    '\\.p7b$',
    '\\.cer$',
    '\\.cert$',
    '\\.mobileprovision$',
    '\\.key$',
    '\\.pem$',
    '/\\.env',
    '/certs($|/)',
    '/signing($|/)',
  ],
}

// Signing material lives on the build Mac (Keychain + files outside this
// repo), never in git. Identity is a Keychain lookup name, not a private key.
// APPLE_API_KEY is a filesystem path to AuthKey_*.p8 — keep that file outside
// this repo (see docs/release.md for where it lives on the build Mac).
const osxSignIdentity = process.env.DSH_OSX_SIGN_IDENTITY
if (osxSignIdentity) {
  packagerConfig.osxSign = {
    identity: osxSignIdentity,
    // Packager's default (true) swallows codesign failures and ships an
    // ad-hoc-signed app that only fails later, at notarization. Fail loudly.
    continueOnError: false,
    optionsForFile: (filePath) => {
      // The bundled node runs plugins that pnpm installs at runtime — code
      // that is not signed by us. Under the hardened runtime (mandatory for
      // notarization) that needs library validation off, plus node's usual
      // JIT allowances (mirrors the official binary's entitlements, minus
      // get-task-allow, which notarization rejects).
      if (filePath.includes(`${path.sep}Resources${path.sep}runtime${path.sep}`)) {
        return {
          entitlements: [
            'com.apple.security.cs.allow-jit',
            'com.apple.security.cs.allow-unsigned-executable-memory',
            'com.apple.security.cs.allow-dyld-environment-variables',
            'com.apple.security.cs.disable-library-validation',
          ],
        }
      }
      return null // Electron binaries keep osx-sign's platform defaults.
    },
  }
}
const appleApiKey = process.env.APPLE_API_KEY
const appleApiKeyId = process.env.APPLE_API_KEY_ID
const appleApiIssuer = process.env.APPLE_API_ISSUER
if (appleApiKey && appleApiKeyId && appleApiIssuer) {
  packagerConfig.osxNotarize = { appleApiKey, appleApiKeyId, appleApiIssuer }
}

export default {
  packagerConfig,
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
        // Squirrel.Windows package ids must not contain spaces.
        name: 'DSH',
        setupExe: 'DSH-Setup.exe',
        setupIcon: path.join(ROOT, 'assets', 'icon.ico'),
      },
    },
  ],
  hooks: {
    postMake: async (_config, makeResults) => {
      cleanUnpackagedOutput()
      return collectArtifacts(makeResults)
    },
  },
}
