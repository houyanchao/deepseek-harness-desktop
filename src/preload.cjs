/**
 * Preload for the shell's own header page (pages/chrome.html): wires the
 * update pill to the main process. The dsh GUI lives in a separate
 * WebContentsView and is never touched.
 */

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('update')
  button.addEventListener('click', () => ipcRenderer.send('updates:apply'))
  ipcRenderer.on('updates:available', (_event, info) => {
    button.title = info.label
    button.classList.add('show')
  })
  ipcRenderer.on('updates:applied', () => button.classList.remove('show'))

  const version = document.getElementById('version')
  version.addEventListener('click', () => ipcRenderer.send('versions:open'))
  ipcRenderer.on('versions:current', (_event, info) => {
    version.textContent = info.version === null ? '' : `DeepSeek Harness ${info.version}`
    version.classList.toggle('show', info.version !== null)
  })
})
