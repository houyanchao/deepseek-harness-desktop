/**
 * Local fake update manifest for testing the unified update flow end to end
 * without any real hosting:
 *
 *   node scripts/serve-test-manifest.mjs            # shell 99.0.0 (tests the shell channel)
 *   node scripts/serve-test-manifest.mjs --dsh X    # additionally pin dsh to version X
 *   node scripts/serve-test-manifest.mjs --file update-manifest.example.json
 *                                                   # serve an actual manifest file as-is
 *
 * Then in another terminal:
 *
 *   DSH_DESKTOP_MANIFEST=http://127.0.0.1:8799/manifest.json pnpm start
 *
 * Expected: the update pill appears top-right in the window; clicking it (or
 * the menu item) walks the dialogs. The shell entry's download URL points at
 * this server too, so "前往下载" is observable without downloading anything real.
 */

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = 8799
const dshIndex = process.argv.indexOf('--dsh')
const dshVersion = dshIndex === -1 ? undefined : process.argv[dshIndex + 1]
const fileIndex = process.argv.indexOf('--file')
const manifestFile = fileIndex === -1 ? undefined : process.argv[fileIndex + 1]

const manifest = manifestFile !== undefined
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : {
      shell: {
        version: '99.0.0',
        mac: `http://127.0.0.1:${PORT}/fake-download`,
        win: `http://127.0.0.1:${PORT}/fake-download`,
      },
      ...dshVersion === undefined ? {} : {
        dsh: {
          // Curated picker allowlist: the version window should offer exactly
          // this entry (plus locally installed versions) with these notes.
          // The first entry is also the recommended/pinned version.
          versions: [{ version: dshVersion, notes: '本地测试清单中的版本' }],
        },
      },
    }

createServer((request, response) => {
  console.log(`${new Date().toISOString()} GET ${request.url}`)
  if (request.url === '/fake-download') {
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end('这是测试下载页 — 真实场景中这里是新版安装包。\n')
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(manifest, null, 2))
}).listen(PORT, '127.0.0.1', () => {
  console.log(`test manifest: http://127.0.0.1:${PORT}/manifest.json`)
  console.log(JSON.stringify(manifest, null, 2))
})
