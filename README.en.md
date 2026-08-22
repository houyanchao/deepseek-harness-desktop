# DSH Desktop

[中文](./README.md) | **English**

A desktop client built for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) (DSH) on macOS and Windows: it ships its own runtime, requires zero configuration, works right after install, and lets you switch between DSH versions with one click.

## Features

- **Zero configuration**: Node.js and pnpm are bundled — nothing on your system is required or touched; DSH itself is installed from the registry on first launch.
- **Version management**: open the version list from the header to see each release's publish date and disk footprint; download-and-switch in one click, roll back instantly, and a version that fails to boot rolls back automatically. Idle downloads can be removed to reclaim disk space.
- **Data shared across versions**: all profiles, plugins, and sessions live in one `DSH_HOME`, so switching versions never loses data.
- **Two-channel auto update**: a single remote manifest drives both the shell's own update (in-place Squirrel upgrade) and DSH version pinning/allowlisting.
- **Plugin preinstall**: recommended plugins (the plugin market `dshmarket` and `dsh-timeline`) are installed automatically on first boot; plugins that already exist or that the user removed are never re-installed.
- **External links open in your browser**: links leaving the DSH GUI are handed to the system default browser.

## Install

Download the installer for your platform from [Releases](https://github.com/houyanchao/deepseek-harness-desktop/releases):

- macOS (Apple Silicon): `DSH-<version>-arm64.dmg`
- Windows: `DSH-Setup.exe`

The first launch needs network access (to download DSH itself); after that the app works offline.

## Architecture

- **The shell (this project)**: process supervision + windows. It spawns
  `dsh web --port 0`, waits for the readiness line
  `dsh web: http://127.0.0.1:<port>` on stdout, then loads the web GUI into the
  window. Shell releases are fully independent from DSH releases.
- **Bundled runtime** (`runtime/`, packaged as a read-only extraResource):
  - Node (a single `bin/node` binary, npm/corepack stripped)
  - the pnpm dist + shims under `runtime/bin` (`pnpm` / `pnpm.cmd`, pinned to the bundled node)
- **DSH is not baked into the shell**: on first launch the registry dist-tag
  (default `latest`) is resolved and installed with the bundled pnpm into
  `userData/runtime/<version>/` (a `.ready` marker guarantees half-finished
  installs get redone). At boot the version pinned by `runtime/current`
  (written by the version switcher) wins; without a pin the newest install is
  used — upgrading DSH just means installing another version directory,
  independent of the shell.
- **Version switching** (`src/versions.mjs`): the header button opens a
  dedicated window (`pages/versions.html`) listing every offered version with
  its publish date and disk usage (measured for downloaded versions, estimated
  otherwise), marking what is downloaded and what is running. Switching =
  download on demand → write `runtime/current` → restart the DSH child in
  place (an unbootable version rolls back automatically), then close the
  window and confirm with a toast. Old versions are not deleted on switch
  (instant, offline-safe rollback); a retention policy bounds disk usage
  instead: the active version plus the two newest others are kept, anything
  older is cleaned up in the background. Non-active versions can also be
  removed by hand (program files only — `DSH_HOME` data is untouched).
- **Plugin preinstall** (`src/plugins.mjs`): the update manifest's
  `dsh.plugins` lists the plugins a fresh install should start with, checked
  before every DSH start — plugins the profile already has are skipped, and
  plugins the shell installed once are never touched again (removing one later
  is respected; state lives in `dsh-home/.preinstalled-plugins.json`). A failed
  install is retried on later launches, up to 3 attempts. Installs go through
  `dsh plugin --profile web add` (never raw pnpm) so DSH reconciles the plugin
  into the profile's bundles — no extra restart needed. Everything is
  best-effort: an unreachable manifest or a failed install never blocks
  startup.
- **User data** (`userData = <appData>/dsh-desktop`, decoupled from the display name):
  - `dsh-home/`: `DSH_HOME` — all DSH profiles, plugins, and sessions
  - `runtime/<version>/`: DSH installs (first boot + upgrades)
  - `logs/`: `install.log` (install output), `dsh.log` (DSH child output)

## Development

```bash
pnpm install
pnpm run bundle-runtime   # download node/pnpm into ./runtime (current platform)
pnpm run build-icons      # generate icon.icns / icon.ico from assets/icon.svg (mac only)
pnpm run smoke            # smoke test: the real first-boot path (registry install + dsh web)
pnpm run test-manifest    # unit test: update-manifest parsing
pnpm run test-plugins     # unit test: plugin-preinstall decision logic
pnpm start                # run in development mode
```

## Packaging

```bash
pnpm run bundle-runtime -- --platform darwin --arch arm64
pnpm run make             # produces zip/dmg (mac) or zip/Setup.exe (win) under out/make
# dmg only (reusing an already-packaged build):
pnpm exec electron-forge make --skip-package --targets @electron-forge/maker-dmg
```

The runtime contains only node + pnpm with no native build steps, so any
platform can stage for any target platform; running the Electron packaging
itself on the target platform is still recommended (signing requirements).

## Update mechanism (unified manifest)

The "Check for Updates…" menu is driven by **one remote JSON manifest**
covering both channels (`src/update-manifest.mjs`):

```json
{
  "shell": {
    "version": "0.2.0",
    "mac": "<dmg url>",
    "win": "<setup exe url>",
    "macFeed": "<squirrel json url>",
    "winFeed": "<squirrel dir url>"
  },
  "dsh": {
    "version": "0.1.0-rc.8",
    "versions": ["0.1.0-rc.8", "0.1.0-rc.7"],
    "plugins": ["dshmarket", { "package": "dsh-timeline", "version": "0.1.3" }]
  }
}
```

- **shell**: a manifest version newer than the local one prefers automatic
  in-place update (`src/shell-updater.mjs`, Electron's built-in Squirrel
  autoUpdater): with a feed configured for the platform it downloads in the
  background and prompts for a restart; without a feed, with an unpublished
  feed, or when applying fails (e.g. unsigned mac build) it falls back to a
  dialog guiding a manual download.
  - `macFeed`: the address of a static JSON file containing
    `{"url": "<zip produced by maker-zip>"}`. **mac auto-update strictly
    requires a signed app** — Squirrel.Mac refuses to swap in unsigned builds.
  - `winFeed`: a directory address holding maker-squirrel's `RELEASES` and
    `.nupkg`. Windows auto-updates without signing (only a SmartScreen prompt
    at install time).
- **dsh**: the manifest pins the DSH version desktop users should run
  (release pace is manifest-controlled — brake/rollback possible). A newer
  version is installed by pnpm in the background into
  `userData/runtime/<version>/` and takes effect on restart. The first-boot
  install also reads the manifest first, falling back to the registry
  dist-tag when unreachable.
- **dsh.versions (optional)**: a hand-curated version allowlist driving the
  version picker — new official releases are verified locally first, and only
  verified ones are added to let users switch. When configured, the window
  shows only the allowlist (plus locally downloaded versions, so switching
  back always stays possible); configured-but-unreachable fails closed
  (downloaded-only); without the field the full registry list is offered.
  Entries are version strings or objects with a `version` field (extra fields
  are ignored — handy for your own notes). Order does not matter; the window
  sorts newest first.
- **dsh.plugins (optional)**: the plugins a fresh install should start with,
  preinstalled on first boot (see Architecture above). Entries are package
  names (installs latest) or `{ "package": "...", "version": "..." }` objects
  (pins a version). Only affects machines that never had the plugin; existing
  users are never force-installed.
- The manifest address lives in `config.mjs` as `UPDATE_MANIFEST_URL`.
  **Currently (transition state) it points at the bundled
  `update-manifest.json`** (a `file:` URL), so allowlisting/pinning works
  today — but a bundled manifest is frozen at package time: no remote
  brake/rollback, and every manifest change needs a repackaged release. Once
  static hosting is ready, switch it to an https address to regain full
  "edit the online JSON, effective everywhere" power (the
  `DSH_DESKTOP_MANIFEST` environment variable overrides it for local
  testing). When the manifest is unreachable: the shell channel is skipped,
  DSH first-boot falls back to registry latest, and the version window shows
  installed versions only.

## Configuration (`src/config.mjs`)

| Constant | Description |
|---|---|
| `NODE_VERSION` / `PNPM_VERSION` | bundled runtime versions (Node must satisfy DSH engines) |
| `DSH_PACKAGE` / `DSH_DIST_TAG` | the DSH package name and fallback dist-tag (default latest) |
| `REGISTRY` | registry for DSH installs and the profile `.npmrc`, default npmmirror |
| `UPDATE_MANIFEST_URL` | unified update-manifest address; `null` uses fallback behavior |

## Releasing a new version

1. Bump `version` in `package.json`, then `pnpm run bundle-runtime && pnpm run make`
   (run on each target platform for mac and win).
2. Upload the artifacts to static hosting: the mac zip + dmg, the win
   `Setup.exe` + `RELEASES` + `.nupkg`.
3. For mac, also publish a feed JSON (`{"url": "<zip url>"}`).
4. Update the manifest JSON's `shell.version` and the download/feed
   addresses. Older installs light up the "Update" button on next launch and
   upgrade with one click.

## License

This project is open source under the [GNU General Public License v3.0](./LICENSE).

Copyright (C) 2026 houyanchao
