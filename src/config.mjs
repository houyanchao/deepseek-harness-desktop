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
 * The unified update manifest driving both channels (shell installer version
 * + pinned dsh version + the picker's curated version allowlist).
 *
 * Transition state: it points at update-manifest.json bundled with the app,
 * so the curation gate works today — but a bundled manifest is frozen at
 * package time (no remote brake/rollback, edits need a repackage). Once the
 * file moves to static hosting, replace this with its https address.
 */
export const UPDATE_MANIFEST_URL = process.env.DSH_DESKTOP_MANIFEST
  ?? new URL('../update-manifest.json', import.meta.url).href

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
