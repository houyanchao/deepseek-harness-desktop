/** Application menu: the standard roles plus "检查更新…" in its native seat. */

import { app, Menu } from 'electron'
import { checkForUpdates } from './updates.mjs'

const CHECK_UPDATES_ITEM = {
  label: '检查更新…',
  click: () => void checkForUpdates(),
}

export function installAppMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    // mac: the app menu right after the Apple logo; other platforms put the
    // update entry under Help instead.
    ...isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            CHECK_UPDATES_ITEM,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : [],
    // The GUI is a web page: without these roles cmd/ctrl+C/V/Z stop working.
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...isMac ? [] : [{ role: 'help', submenu: [CHECK_UPDATES_ITEM] }],
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
