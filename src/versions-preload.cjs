/**
 * Preload for the version picker window (pages/versions.html): renders the
 * catalog pushed by the main process and sends back switch/remove requests.
 */

const { ipcRenderer } = require('electron')

const formatSize = (bytes) => (bytes >= 1024 * 1024 * 1024
  ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  : `${Math.round(bytes / 1024 / 1024)} MB`)

/** Downloaded rows show the measured footprint; others only an honest estimate. */
const sizeText = (entry, estimate) => {
  if (entry.installed) return entry.diskSize === null ? '占用大小未知' : `占用 ${formatSize(entry.diskSize)}`
  return estimate === null ? '安装体积未知' : `安装约需 ${formatSize(estimate)}`
}

function buildRow(entry, current, estimate, index, animate, port) {
  const row = document.createElement('div')
  row.className = ['row', animate ? null : 'no-anim', entry.version === current ? 'is-current' : null]
    .filter((name) => name !== null)
    .join(' ')
  row.dataset.version = entry.version
  // Staggered entrance, capped so long lists don't feel sluggish.
  if (animate) row.style.animationDelay = `${Math.min(index, 10) * 22}ms`

  const info = document.createElement('div')
  info.className = 'info'

  const line1 = document.createElement('div')
  line1.className = 'line1'
  const version = document.createElement('span')
  version.className = 'version'
  version.textContent = entry.version
  line1.append(version)
  if (entry.version === current) {
    const badge = document.createElement('span')
    badge.className = 'badge current'
    badge.textContent = '当前版本'
    line1.append(badge)
  } else if (entry.installed) {
    const badge = document.createElement('span')
    badge.className = 'badge installed'
    badge.textContent = '已下载'
    line1.append(badge)
  }
  info.append(line1)

  const meta = document.createElement('div')
  meta.className = 'meta'
  // An unknown publish date is left out entirely rather than shown as "未知".
  meta.textContent = [
    typeof entry.publishedAt === 'string' ? `发布于 ${entry.publishedAt.slice(0, 10)}` : null,
    sizeText(entry, estimate),
  ].filter((part) => part !== null).join(' · ')
  info.append(meta)
  row.append(info)

  const actions = document.createElement('div')
  actions.className = 'actions'
  // Only an idle download can be removed; the running version must stay.
  if (entry.installed && entry.version !== current) {
    const remove = document.createElement('button')
    remove.className = 'ghost'
    remove.textContent = '删除'
    remove.title = '删除本机上的这个版本，释放磁盘空间'
    remove.addEventListener('click', () => ipcRenderer.send('versions:remove', entry.version))
    actions.append(remove)
  }
  const button = document.createElement('button')
  if (entry.version === current) {
    button.textContent = port === null ? '启用中' : `启用中，端口号${port}`
    button.disabled = true
  } else {
    button.textContent = entry.installed ? '切换' : '下载并切换'
    button.addEventListener('click', () => ipcRenderer.send('versions:switch', entry.version))
  }
  actions.append(button)
  row.append(actions)
  return row
}

/** Only the first paint (which replaces the skeleton) animates its rows in. */
let painted = false

/** Header summary: which version is running. */
function renderHead(data) {
  const head = document.getElementById('head-current')
  head.textContent = ''
  const label = document.createElement('span')
  label.className = 'dim'
  label.textContent = '当前版本'
  head.append(label, document.createTextNode(data.current ?? '未安装'))
}

ipcRenderer.on('versions:data', (_event, data) => {
  renderHead(data)
  const notice = document.getElementById('notice')
  notice.textContent = data.notice ?? ''
  notice.classList.toggle('show', data.notice !== null)
  const list = document.getElementById('list')
  const scrolled = document.documentElement.scrollTop
  list.textContent = ''
  if (data.entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'loading'
    empty.textContent = '没有可用的版本。'
    list.append(empty)
    return
  }
  const animate = !painted
  painted = true
  data.entries.forEach((entry, index) => {
    list.append(buildRow(entry, data.current, data.estimate, index, animate, data.port ?? null))
  })
  document.documentElement.scrollTop = scrolled
})

// The main process confirms an actual deletion (post-confirmation dialog), so
// the collapse plays only when the version is really gone.
ipcRenderer.on('versions:removed', (_event, version) => {
  const row = document.querySelector(`.row[data-version="${version}"]`)
  if (row !== null) row.classList.add('removing')
})

ipcRenderer.on('versions:progress', (_event, progress) => {
  const box = document.getElementById('progress')
  const text = document.getElementById('progress-text')
  const fill = document.getElementById('progress-fill')

  if (progress.phase === 'download' || progress.phase === 'starting') {
    for (const button of document.querySelectorAll('.row button')) button.disabled = true
    for (const row of document.querySelectorAll('.row')) {
      row.classList.toggle('switching-target', row.dataset.version === progress.version)
    }
    box.classList.add('show')
    if (progress.phase === 'download' && typeof progress.percent === 'number') {
      fill.classList.remove('indeterminate')
      fill.style.width = `${progress.percent}%`
      text.textContent = `正在下载安装 DeepSeek Harness ${progress.version}…（${progress.percent}%）`
    } else if (progress.phase === 'download') {
      fill.classList.add('indeterminate')
      text.textContent = `正在下载安装 DeepSeek Harness ${progress.version}…`
    } else {
      fill.classList.add('indeterminate')
      text.textContent = `正在启动 DeepSeek Harness ${progress.version}…`
    }
    return
  }

  // error: the main process re-sends the catalog right after, which
  // re-renders the rows (and so re-enables their buttons). On success the
  // window is closed by the main process and a toast takes over.
  fill.classList.remove('indeterminate')
  fill.style.width = '0%'
  box.classList.remove('show')
  for (const row of document.querySelectorAll('.row')) row.classList.remove('switching-target')
})
