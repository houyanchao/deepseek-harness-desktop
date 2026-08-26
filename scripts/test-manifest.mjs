/** Unit smoke for the unified update manifest: serve one locally, assert the plans. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { curatedDshVersions, curatedPlugins, fetchUpdateManifest, planUpdates, recommendedDshVersion } from '../src/update-manifest.mjs'

const manifest = {
  shell: {
    version: '0.2.0',
    macArm64: 'https://dl.example.com/a_arm64.dmg',
    macX64: 'https://dl.example.com/a_x64.dmg',
    win: 'https://dl.example.com/a.exe',
    macFeedArm64: 'https://dl.example.com/feed-arm64.json',
    macFeedX64: 'https://dl.example.com/feed-x64.json',
  },
  // Newest first; the first entry is the recommended version.
  dsh: { versions: ['0.1.0-rc.8', '0.1.0-rc.7'] },
}

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(manifest))
})
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const url = `http://127.0.0.1:${server.address().port}/manifest.json`

const fetched = await fetchUpdateManifest(url)
assert.deepEqual(fetched, manifest)

// Both channels behind → both planned; mac picks its own chip's url and feed.
let plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: '0.1.0-rc.7', platform: 'darwin', arch: 'arm64' })
assert.deepEqual(plan, {
  shell: { version: '0.2.0', url: 'https://dl.example.com/a_arm64.dmg', feed: 'https://dl.example.com/feed-arm64.json' },
  dsh: { version: '0.1.0-rc.8' },
})

// win has no feed configured → manual download only.
plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: '0.1.0-rc.8', platform: 'win32' })
assert.equal(plan.shell.url, 'https://dl.example.com/a.exe')
assert.equal(plan.shell.feed, undefined)

// Everything current → nothing planned; win platform exercised.
plan = planUpdates(fetched, { shellVersion: '0.2.0', dshVersion: '0.1.0-rc.8', platform: 'win32' })
assert.deepEqual(plan, { shell: null, dsh: null })

// The mac link is strictly per-chip; the other chip's key is never consulted,
// and a manifest missing the running chip's key offers no link at all (the
// dialog then has no download button).
plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: null, platform: 'darwin', arch: 'x64' })
assert.equal(plan.shell.url, 'https://dl.example.com/a_x64.dmg')
assert.equal(plan.shell.feed, 'https://dl.example.com/feed-x64.json')
plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: null, platform: 'win32', arch: 'x64' })
assert.equal(plan.shell.url, 'https://dl.example.com/a.exe')
plan = planUpdates(
  { shell: { version: '9.0.0', macArm64: 'https://dl.example.com/a_arm64.dmg' } },
  { shellVersion: '1.0.0', dshVersion: null, platform: 'darwin', arch: 'x64' },
)
assert.equal(plan.shell.url, undefined)

// No dsh installed yet (first boot path) → the list's first entry wins.
plan = planUpdates(fetched, { shellVersion: '0.2.0', dshVersion: null, platform: 'darwin' })
assert.equal(plan.dsh.version, '0.1.0-rc.8')

// Release beats its own prerelease: rc.8 installed, list leads with 0.1.0.
plan = planUpdates({ dsh: { versions: ['0.1.0', '0.1.0-rc.8'] } }, { shellVersion: '0.2.0', dshVersion: '0.1.0-rc.8', platform: 'darwin' })
assert.equal(plan.dsh.version, '0.1.0')

// The recommended version is versions[0]; an empty or absent list means none,
// and then no dsh update is ever planned.
assert.equal(recommendedDshVersion(fetched), '0.1.0-rc.8')
assert.equal(recommendedDshVersion({ dsh: { versions: [] } }), null)
assert.equal(recommendedDshVersion({}), null)
plan = planUpdates({ dsh: { versions: [] } }, { shellVersion: '0.2.0', dshVersion: null, platform: 'darwin' })
assert.equal(plan.dsh, null)

// file: URLs read a local manifest (the bundled-manifest transition state),
// and the manifest shipped in this repo must always parse and validate.
const bundled = await fetchUpdateManifest(new URL('../update/update-manifest.json', import.meta.url).href)
assert.ok(Array.isArray(bundled.dsh.versions) && bundled.dsh.versions.length > 0)
assert.equal(typeof recommendedDshVersion(bundled), 'string')

// Curated picker list: strings and objects normalize; no field means "not curated".
assert.deepEqual(
  curatedDshVersions({ dsh: { versions: ['1', { version: '2', notes: '备注' }] } }),
  ['1', '2'],
)
assert.equal(curatedDshVersions({}), null)

// A curated manifest passes validation end to end.
const curatedManifest = { dsh: { versions: [{ version: '2', notes: 'x' }, '1'] } }
const curatedServer = createServer((_request, response) => response.end(JSON.stringify(curatedManifest)))
await new Promise((resolvePromise) => curatedServer.listen(0, '127.0.0.1', resolvePromise))
assert.deepEqual(await fetchUpdateManifest(`http://127.0.0.1:${curatedServer.address().port}/m.json`), curatedManifest)

// Malformed manifest rejects.
const bad = createServer((_request, response) => response.end(JSON.stringify({ shell: { version: 7 } })))
await new Promise((resolvePromise) => bad.listen(0, '127.0.0.1', resolvePromise))
await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${bad.address().port}/x.json`), /格式错误/)

// Malformed dsh.versions entries reject too.
const badVersions = createServer((_request, response) => response.end(JSON.stringify({ dsh: { versions: [7] } })))
await new Promise((resolvePromise) => badVersions.listen(0, '127.0.0.1', resolvePromise))
await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${badVersions.address().port}/x.json`), /格式错误/)

// Preinstall plugin list: strings and { package, version } objects normalize
// to name+spec pairs; no field means "no plugins to preinstall".
assert.deepEqual(
  curatedPlugins({ dsh: { plugins: ['@x/a', { package: '@x/b', version: '2.0.0' }, { package: '@x/c' }] } }),
  [
    { name: '@x/a', spec: '@x/a' },
    { name: '@x/b', spec: '@x/b@2.0.0' },
    { name: '@x/c', spec: '@x/c' },
  ],
)
assert.deepEqual(curatedPlugins(fetched), [])

// Malformed dsh.plugins entries reject: empty strings, package-less objects,
// and non-string versions (which would otherwise be silently dropped).
for (const plugins of [[''], [{ version: '1.0.0' }], [{ package: '@x/a', version: 2 }], 'not-an-array']) {
  const badPluginsServer = createServer((_request, response) => response.end(JSON.stringify({ dsh: { plugins } })))
  await new Promise((resolvePromise) => badPluginsServer.listen(0, '127.0.0.1', resolvePromise))
  await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${badPluginsServer.address().port}/x.json`), /格式错误/)
  badPluginsServer.close()
}

server.close()
curatedServer.close()
bad.close()
badVersions.close()
console.log('MANIFEST TEST OK')
