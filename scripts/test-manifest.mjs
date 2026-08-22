/** Unit smoke for the unified update manifest: serve one locally, assert the plans. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { curatedDshVersions, curatedPlugins, fetchUpdateManifest, planUpdates } from '../src/update-manifest.mjs'

const manifest = {
  shell: {
    version: '0.2.0',
    mac: 'https://dl.example.com/a.dmg',
    win: 'https://dl.example.com/a.exe',
    macFeed: 'https://dl.example.com/mac/feed.json',
  },
  dsh: { version: '0.1.0-rc.8' },
}

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(manifest))
})
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const url = `http://127.0.0.1:${server.address().port}/manifest.json`

const fetched = await fetchUpdateManifest(url)
assert.deepEqual(fetched, manifest)

// Both channels behind → both planned; mac picks the mac url and feed.
let plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: '0.1.0-rc.7', platform: 'darwin' })
assert.deepEqual(plan, {
  shell: { version: '0.2.0', url: 'https://dl.example.com/a.dmg', feed: 'https://dl.example.com/mac/feed.json' },
  dsh: { version: '0.1.0-rc.8' },
})

// win has no feed configured → manual download only.
plan = planUpdates(fetched, { shellVersion: '0.1.0', dshVersion: '0.1.0-rc.8', platform: 'win32' })
assert.equal(plan.shell.url, 'https://dl.example.com/a.exe')
assert.equal(plan.shell.feed, undefined)

// Everything current → nothing planned; win platform exercised.
plan = planUpdates(fetched, { shellVersion: '0.2.0', dshVersion: '0.1.0-rc.8', platform: 'win32' })
assert.deepEqual(plan, { shell: null, dsh: null })

// No dsh installed yet (first boot path) → manifest version wins.
plan = planUpdates(fetched, { shellVersion: '0.2.0', dshVersion: null, platform: 'darwin' })
assert.equal(plan.dsh.version, '0.1.0-rc.8')

// Release beats its own prerelease: rc.8 installed, manifest pins 0.1.0.
plan = planUpdates({ dsh: { version: '0.1.0' } }, { shellVersion: '0.2.0', dshVersion: '0.1.0-rc.8', platform: 'darwin' })
assert.equal(plan.dsh.version, '0.1.0')

// file: URLs read a local manifest (the bundled-manifest transition state),
// and the manifest shipped in this repo must always parse and validate.
const bundled = await fetchUpdateManifest(new URL('../update-manifest.json', import.meta.url).href)
assert.equal(typeof bundled.dsh.version, 'string')
assert.ok(Array.isArray(bundled.dsh.versions) && bundled.dsh.versions.length > 0)

// Curated picker list: strings and objects normalize; no field means "not curated".
assert.deepEqual(
  curatedDshVersions({ dsh: { version: '2', versions: ['1', { version: '2', notes: '备注' }] } }),
  ['1', '2'],
)
assert.equal(curatedDshVersions(fetched), null)

// A curated manifest passes validation end to end.
const curatedManifest = { dsh: { version: '2', versions: [{ version: '2', notes: 'x' }, '1'] } }
const curatedServer = createServer((_request, response) => response.end(JSON.stringify(curatedManifest)))
await new Promise((resolvePromise) => curatedServer.listen(0, '127.0.0.1', resolvePromise))
assert.deepEqual(await fetchUpdateManifest(`http://127.0.0.1:${curatedServer.address().port}/m.json`), curatedManifest)

// Malformed manifest rejects.
const bad = createServer((_request, response) => response.end(JSON.stringify({ dsh: { version: 7 } })))
await new Promise((resolvePromise) => bad.listen(0, '127.0.0.1', resolvePromise))
await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${bad.address().port}/x.json`), /格式错误/)

// Malformed dsh.versions entries reject too.
const badVersions = createServer((_request, response) => response.end(JSON.stringify({ dsh: { version: '1', versions: [7] } })))
await new Promise((resolvePromise) => badVersions.listen(0, '127.0.0.1', resolvePromise))
await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${badVersions.address().port}/x.json`), /格式错误/)

// Preinstall plugin list: strings and { package, version } objects normalize
// to name+spec pairs; no field means "no plugins to preinstall".
assert.deepEqual(
  curatedPlugins({ dsh: { version: '1', plugins: ['@x/a', { package: '@x/b', version: '2.0.0' }, { package: '@x/c' }] } }),
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
  const badPluginsServer = createServer((_request, response) => response.end(JSON.stringify({ dsh: { version: '1', plugins } })))
  await new Promise((resolvePromise) => badPluginsServer.listen(0, '127.0.0.1', resolvePromise))
  await assert.rejects(fetchUpdateManifest(`http://127.0.0.1:${badPluginsServer.address().port}/x.json`), /格式错误/)
  badPluginsServer.close()
}

server.close()
curatedServer.close()
bad.close()
badVersions.close()
console.log('MANIFEST TEST OK')
