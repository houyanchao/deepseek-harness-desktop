/** Build-time and runtime constants for the desktop shell. */

/** Node runtime bundled into the app; must satisfy dsh's engines (^22.19.0 || >=24). */
export const NODE_VERSION = '24.19.0'

/** pnpm bundled into the app; dsh's plugin subsystem shells out to it. */
export const PNPM_VERSION = '11.7.0'

/** The dsh CLI package, installed from the registry on first boot. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Dist-tag resolved against the registry when the manifest names no dsh version. */
export const DSH_DIST_TAG = 'latest'

/**
 * Where the hosted update-manifest.json lives (Qiniu). The repo's update/
 * directory is the master copy of everything hosted there (manifest + the
 * Squirrel.Mac feed JSONs): edit files there, upload them to Qiniu, then
 * refresh the CDN cache in the Qiniu console.
 */
const HOSTED_MANIFEST_URL = 'https://image.bushishier.com/dshdesktop/update-manifest.json'

/**
 * The unified update manifest driving both channels (shell installer version
 * + pinned dsh version + the picker's curated version allowlist).
 *
 * Resolution order: explicit env override → hosted address (remote brake:
 * edits take effect without repackaging) → the manifest bundled with the app.
 * Every consumer already degrades when the address is unreachable (registry
 * fallback / skip / fail-closed picker), so a hosting outage never blocks
 * startup.
 */
export const UPDATE_MANIFEST_URL = process.env.DSH_DESKTOP_MANIFEST
  ?? HOSTED_MANIFEST_URL
  ?? new URL('../update/update-manifest.json', import.meta.url).href

/**
 * Registry used for the profile's .npmrc (plugin installs) and the staging
 * install. npmmirror is the default so mainland-China users get working
 * plugin installs out of the box; override with DSH_DESKTOP_REGISTRY.
 */
export const REGISTRY = process.env.DSH_DESKTOP_REGISTRY ?? 'https://registry.npmmirror.com'

/** The project repository, linked from the header's GitHub button. */
export const REPO_URL = 'https://github.com/houyanchao/deepseek-harness-desktop'

/** Fixed userData directory name, decoupled from the display name on purpose. */
export const USER_DATA_DIR_NAME = 'dsh-desktop'

/** The dsh profile the shell boots and preinstalls plugins into. */
export const PROFILE = 'web'
