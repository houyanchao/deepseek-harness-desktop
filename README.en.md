# deepseek-harness-desktop

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
