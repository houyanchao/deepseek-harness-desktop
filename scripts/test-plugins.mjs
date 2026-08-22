/** Unit smoke for plugin-preinstall decisions: what counts as missing, and how state gates retries. */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  installedPluginNames,
  MAX_ATTEMPTS,
  readPreinstallState,
  selectMissingPlugins,
  writePreinstallState,
} from '../src/plugins.mjs'

const plugin = (name) => ({ name, spec: name })

// Nothing installed, nothing attempted → everything is missing.
assert.deepEqual(
  selectMissingPlugins({ desired: [plugin('@x/a'), plugin('@x/b')], installed: new Set(), state: {} }),
  [plugin('@x/a'), plugin('@x/b')],
)

// Already in the profile (user installed it themselves) → skipped.
assert.deepEqual(
  selectMissingPlugins({ desired: [plugin('@x/a')], installed: new Set(['@x/a']), state: {} }),
  [],
)

// Installed by the shell once, then removed by the user (gone from the
// profile, but recorded) → the removal is respected, never reinstalled.
assert.deepEqual(
  selectMissingPlugins({
    desired: [plugin('@x/a')],
    installed: new Set(),
    state: { '@x/a': { status: 'installed', attempts: 1 } },
  }),
  [],
)

// A past failure under the attempt cap → retried on this launch.
assert.deepEqual(
  selectMissingPlugins({
    desired: [plugin('@x/a')],
    installed: new Set(),
    state: { '@x/a': { status: 'failed', attempts: MAX_ATTEMPTS - 1 } },
  }),
  [plugin('@x/a')],
)

// Failed too many times → given up, not retried forever.
assert.deepEqual(
  selectMissingPlugins({
    desired: [plugin('@x/a')],
    installed: new Set(),
    state: { '@x/a': { status: 'failed', attempts: MAX_ATTEMPTS } },
  }),
  [],
)

// Profile reading: dependencies and activated bundles both count as present;
// a missing package.json (profile not initialized yet) reads as empty.
const dir = await mkdtemp(path.join(tmpdir(), 'dsh-plugins-test-'))
try {
  assert.deepEqual(await installedPluginNames(dir), new Set())
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { '@x/a': '^1.0.0' },
    dsh: { profile: { bundles: ['@x/b'] } },
  }))
  assert.deepEqual(await installedPluginNames(dir), new Set(['@x/a', '@x/b']))

  // State round-trip; a missing or corrupt file reads as "nothing attempted".
  const statePath = path.join(dir, 'state.json')
  assert.deepEqual(await readPreinstallState(statePath), {})
  await writePreinstallState(statePath, { '@x/a': { status: 'installed', attempts: 1 } })
  assert.deepEqual(await readPreinstallState(statePath), { '@x/a': { status: 'installed', attempts: 1 } })
  await writeFile(statePath, 'not json')
  assert.deepEqual(await readPreinstallState(statePath), {})
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('PLUGINS TEST OK')
