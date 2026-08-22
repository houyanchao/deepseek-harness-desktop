/**
 * Rasterize assets/icon.svg into the platform icon files electron-packager
 * consumes: assets/icon.icns (mac) and assets/icon.ico (win).
 *
 *   node scripts/build-icons.mjs
 *
 * macOS-only (uses the built-in sips/iconutil), which is fine: the icons are
 * committed, so packaging on other platforms just reuses them. Re-run after
 * editing the SVG.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const SVG = path.join(ASSETS, 'icon.svg')
const WORK = path.join(ASSETS, '.build')

/** Apple's iconset expects both @1x and @2x of each nominal size. */
const ICNS_ENTRIES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

if (!existsSync(SVG)) throw new Error(`missing icon source: ${SVG}`)
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

/** Rasterize the SVG at one square size; sips reads SVG via ImageIO. */
function render(size, target) {
  execFileSync('sips', ['-s', 'format', 'png', '--resampleHeightWidth', String(size), String(size), SVG, '--out', target], {
    stdio: 'ignore',
  })
  return target
}

const iconset = path.join(WORK, 'icon.iconset')
mkdirSync(iconset, { recursive: true })
for (const [name, size] of ICNS_ENTRIES) render(size, path.join(iconset, name))
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'icon.icns')], { stdio: 'inherit' })

// ICO: a directory of PNG-compressed images. 256px records its size as 0,
// the format's escape for "not 1..255".
const images = ICO_SIZES.map((size) => ({ size, data: readFileSync(render(size, path.join(WORK, `ico-${size}.png`))) }))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
const directory = Buffer.alloc(16 * images.length)
let offset = header.length + directory.length
images.forEach((image, index) => {
  const at = index * 16
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at)
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
  directory.writeUInt8(0, at + 2)
  directory.writeUInt8(0, at + 3)
  directory.writeUInt16LE(1, at + 4)
  directory.writeUInt16LE(32, at + 6)
  directory.writeUInt32LE(image.data.length, at + 8)
  directory.writeUInt32LE(offset, at + 12)
  offset += image.data.length
})
writeFileSync(path.join(ASSETS, 'icon.ico'), Buffer.concat([header, directory, ...images.map((image) => image.data)]))

rmSync(WORK, { recursive: true, force: true })
console.log(`icons written: ${path.join(ASSETS, 'icon.icns')}, ${path.join(ASSETS, 'icon.ico')}`)
