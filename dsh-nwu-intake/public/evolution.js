(() => {
  const api = '/nwu/api/evolution'
  let queuedFiles = []
  let isUploading = false

  const style = document.createElement('style')
  style.id = 'nwu-evolution-style'
  style.textContent = [
    '#nwu-graph-entry,#nwu-galaxy-entry{position:fixed;right:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border:1px solid rgba(42,76,57,.25);border-radius:999px;background:rgba(246,248,244,.9);color:#244936;text-decoration:none;font:600 13px/1 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(25,50,36,.16);backdrop-filter:blur(16px);transition:transform .18s ease,background .18s ease}',
    '#nwu-graph-entry{top:18px}#nwu-galaxy-entry{top:58px}',
    '#nwu-graph-entry:hover,#nwu-galaxy-entry:hover{background:#edf2eb;border-color:#6c8d76;transform:translateY(-1px)}#nwu-graph-entry svg,#nwu-galaxy-entry svg{width:16px;height:16px}',
    '#nwu-folder-entry{position:fixed;right:20px;top:98px;z-index:2147483000;display:none;align-items:center;gap:7px;padding:8px 13px;border:1px solid rgba(42,76,57,.25);border-radius:999px;background:rgba(39,93,65,.94);color:#fff;font:650 13px/1 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(25,50,36,.18);backdrop-filter:blur(16px);cursor:pointer;transition:transform .18s ease,background .18s ease}#nwu-folder-entry.show{display:inline-flex}#nwu-folder-entry:hover{background:#1c4d35;transform:translateY(-1px)}#nwu-folder-entry svg{width:16px;height:16px}',
    '#nwu-folder-panel{position:fixed;inset:0;z-index:2147483640;display:none;align-items:center;justify-content:center;padding:22px;background:rgba(7,22,15,.48);backdrop-filter:blur(12px)}#nwu-folder-panel.show{display:flex}',
    '.nwu-folder-card{width:min(620px,100%);position:relative;overflow:hidden;border:1px solid rgba(223,236,226,.72);border-radius:24px;background:linear-gradient(150deg,rgba(250,253,250,.98),rgba(238,246,239,.98));box-shadow:0 32px 110px rgba(5,25,16,.32);color:#173827;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}',
    '.nwu-folder-card::before{content:"";position:absolute;inset:0 0 auto;height:6px;background:linear-gradient(90deg,#2f6b4a,#a4c7a0,#d4b278)}.nwu-folder-head{display:flex;gap:18px;padding:31px 32px 12px}.nwu-folder-mark{flex:0 0 40px;height:40px;border-radius:13px;display:grid;place-items:center;background:#275d41;color:#fff;box-shadow:0 10px 25px rgba(37,88,61,.2)}.nwu-folder-mark svg{width:23px}.nwu-folder-head h2{margin:0;font-family:"Noto Serif SC","Songti SC",serif;font-size:25px;line-height:1.3;letter-spacing:.03em}.nwu-folder-head p{margin:6px 0 0;color:#587060}',
    '.nwu-folder-close{position:absolute;right:16px;top:16px;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#54705e;font-size:19px;cursor:pointer}.nwu-folder-close:hover{background:rgba(37,93,65,.09)}.nwu-folder-body{padding:12px 32px 30px}.nwu-folder-well{padding:20px;border:1px dashed #8cad98;border-radius:17px;background:rgba(255,255,255,.55)}.nwu-folder-well strong{display:block;font-size:16px}.nwu-folder-well span{display:block;margin-top:4px;color:#637d6c}.nwu-folder-actions{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}.nwu-folder-primary,.nwu-folder-secondary{border:0;border-radius:10px;padding:10px 14px;font:650 14px/1 system-ui,"Microsoft YaHei",sans-serif;cursor:pointer}.nwu-folder-primary{background:#275d41;color:#fff;box-shadow:0 9px 18px rgba(37,93,65,.2)}.nwu-folder-primary:hover{background:#1c4d35}.nwu-folder-primary:disabled{opacity:.55;cursor:wait}.nwu-folder-secondary{background:transparent;color:#53705d}.nwu-folder-status{min-height:22px;margin-top:16px;color:#4e6f5a}.nwu-folder-progress{height:5px;overflow:hidden;margin-top:9px;border-radius:999px;background:#dce9de}.nwu-folder-progress i{display:block;width:0;height:100%;background:linear-gradient(90deg,#2d704b,#9abf7f);transition:width .22s ease}.nwu-folder-result{margin-top:13px;padding:11px 13px;border-radius:11px;background:rgba(49,111,75,.1);color:#234f37}.nwu-folder-result a{color:#1d6744;font-weight:700}.nwu-folder-error{color:#9e3b32}',
    'body[data-ds-dark-theme] #nwu-graph-entry,body[data-ds-dark-theme] #nwu-galaxy-entry{background:rgba(9,24,18,.78);border-color:rgba(211,230,219,.18);color:#eef5f0;box-shadow:0 12px 36px rgba(0,0,0,.26)}body[data-ds-dark-theme] #nwu-graph-entry:hover,body[data-ds-dark-theme] #nwu-galaxy-entry:hover{background:rgba(19,45,33,.92)}@media(max-width:720px){#nwu-graph-entry{top:auto;right:14px;bottom:14px}#nwu-galaxy-entry{top:auto;right:14px;bottom:60px}#nwu-folder-entry{top:auto;right:14px;bottom:106px}.nwu-folder-panel{padding:12px}.nwu-folder-head{padding:27px 20px 9px;gap:13px}.nwu-folder-head h2{font-size:22px}.nwu-folder-body{padding:12px 20px 22px}}',
  ].join('')
  document.head.append(style)

  const graphEntry = document.createElement('a')
  graphEntry.id = 'nwu-graph-entry'
  graphEntry.href = '/nwu/knowledge-graph'
  graphEntry.title = '查看知识图谱'
  graphEntry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="5.4" cy="7" r="2.2" stroke="currentColor" stroke-width="1.8"/><circle cx="17.6" cy="5.5" r="1.9" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="17.2" r="2.7" stroke="currentColor" stroke-width="1.8"/><path d="m7.4 8.2 2.8 7M15.9 6.9l-2.3 8M7.6 7.4l8-1.5" stroke="currentColor" stroke-width="1.5"/></svg><span>知识图谱</span>'
  document.body.append(graphEntry)

  const galaxyEntry = document.createElement('a')
  galaxyEntry.id = 'nwu-galaxy-entry'
  galaxyEntry.href = '/nwu/knowledge-galaxy'
  galaxyEntry.title = '三维教务知识星系'
  galaxyEntry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.1" stroke="currentColor" stroke-width="1.7"/><ellipse cx="12" cy="12" rx="9.2" ry="3.6" stroke="currentColor" stroke-width="1.3" transform="rotate(-18 12 12)"/><circle cx="19.2" cy="8.6" r="1.1" fill="currentColor"/><circle cx="4.6" cy="15" r=".9" fill="currentColor"/></svg><span>知识星系</span>'
  document.body.append(galaxyEntry)

  const folderEntry = document.createElement('button')
  folderEntry.id = 'nwu-folder-entry'
  folderEntry.type = 'button'
  folderEntry.title = '选择教务文件总文件夹'
  folderEntry.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 18 9.2 8.5l3.1 4.4L15.2 9 21 18H3Z" fill="currentColor" opacity=".86"/><path d="M12 4v6.4m0-6.4L9.7 6.3M12 4l2.3 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>选择资料夹</span>'
  document.body.append(folderEntry)

  const panel = document.createElement('section')
  panel.id = 'nwu-folder-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-labelledby', 'nwu-folder-title')
  panel.innerHTML = '<div class="nwu-folder-card"><button class="nwu-folder-close" type="button" aria-label="关闭">×</button><div class="nwu-folder-head"><div class="nwu-folder-mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 18 9.2 8.5l3.1 4.4L15.2 9 21 18H3Z" fill="currentColor" opacity=".9"/><path d="M12 4v6.4m0-6.4L9.7 6.3M12 4l2.3 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div><div><h2 id="nwu-folder-title">选择教务文件总文件夹</h2><p>请选中教务处通知、规章制度、办事指南等文件所在的同一个文件夹，支持文字、PDF、Word、图片与常见数据文件。</p></div></div><div class="nwu-folder-body"><div class="nwu-folder-well"><strong id="nwu-folder-summary">尚未选择资料夹</strong><span>系统会把原件与提取正文写入 SQLite 知识库，并自动生成知识关联图谱。</span></div><div class="nwu-folder-actions"><button class="nwu-folder-primary" type="button" data-action="choose">选择教务文件总文件夹</button><button class="nwu-folder-secondary" type="button" data-action="close">稍后再说</button><input data-role="files" type="file" hidden multiple webkitdirectory directory></div><div class="nwu-folder-status" data-role="status"></div><div class="nwu-folder-progress" hidden><i></i></div><div class="nwu-folder-result" data-role="result" hidden></div></div></div>'
  document.body.append(panel)

  const input = panel.querySelector('[data-role="files"]')
  const chooseButton = panel.querySelector('[data-action="choose"]')
  const summary = panel.querySelector('#nwu-folder-summary')
  const status = panel.querySelector('[data-role="status"]')
  const progress = panel.querySelector('.nwu-folder-progress')
  const progressBar = progress.querySelector('i')
  const result = panel.querySelector('[data-role="result"]')

  function openPanel() {
    if (isUploading) return
    panel.classList.add('show')
    chooseButton.focus()
  }

  function closePanel() {
    if (!isUploading) panel.classList.remove('show')
  }

  function showEvolutionEntry(show) {
    folderEntry.classList.toggle('show', show)
  }

  function bytes(value) {
    if (value < 1024 * 1024) return Math.max(1, Math.round(value / 1024)) + ' KB'
    return (value / 1024 / 1024).toFixed(1) + ' MB'
  }

  function selectFiles(files) {
    queuedFiles = Array.from(files || [])
    result.hidden = true
    status.textContent = ''
    if (!queuedFiles.length) {
      summary.textContent = '没有找到可收录的文件'
      return
    }
    const relative = queuedFiles[0].webkitRelativePath || queuedFiles[0].name
    const folder = relative.split('/')[0]
    const total = queuedFiles.reduce((sum, file) => sum + file.size, 0)
    summary.textContent = folder + '，共 ' + queuedFiles.length + ' 份文件，' + bytes(total)
    chooseButton.textContent = '收录并生成图谱'
  }

  async function uploadFile(file) {
    const params = new URLSearchParams({
      name: file.name,
      path: file.webkitRelativePath || file.name,
    })
    const response = await fetch(api + '/sources?' + params.toString(), {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '收录失败')
    return payload
  }

  async function startUpload() {
    if (isUploading) return
    if (!queuedFiles.length) {
      input.click()
      return
    }
    isUploading = true
    chooseButton.disabled = true
    progress.hidden = false
    result.hidden = true
    let cursor = 0
    let completed = 0
    let failed = 0
    const total = queuedFiles.length
    const worker = async () => {
      while (cursor < total) {
        const index = cursor++
        const file = queuedFiles[index]
        status.textContent = '正在收录 ' + (index + 1) + '/' + total + '：' + file.name
        try {
          await uploadFile(file)
        } catch (error) {
          failed++
        }
        completed++
        progressBar.style.width = Math.round(completed / total * 100) + '%'
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, total) }, worker))
    try {
      const graph = await fetch(api + '/graph', { cache: 'no-store' }).then(response => response.json())
      status.textContent = failed ? '已收录 ' + (total - failed) + ' 份文件，' + failed + ' 份未成功。' : '已收录全部 ' + total + ' 份文件。'
      status.className = 'nwu-folder-status' + (failed ? ' nwu-folder-error' : '')
      result.innerHTML = '资料关联图谱已生成，当前有 ' + graph.stats.graphNodes + ' 个节点、' + graph.stats.graphLinks + ' 条关联。<a href="/nwu/knowledge-graph">查看知识图谱</a>'
      result.hidden = false
      chooseButton.textContent = '已完成'
    } catch (error) {
      status.textContent = '资料已收录，但图谱加载失败：' + error.message
      status.className = 'nwu-folder-status nwu-folder-error'
    } finally {
      isUploading = false
      chooseButton.disabled = false
    }
  }

  chooseButton.addEventListener('click', startUpload)
  folderEntry.addEventListener('click', openPanel)
  input.addEventListener('change', () => selectFiles(input.files))
  panel.querySelector('[data-action="close"]').addEventListener('click', closePanel)
  panel.querySelector('.nwu-folder-close').addEventListener('click', closePanel)
  panel.addEventListener('click', event => { if (event.target === panel) closePanel() })

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button,[role="button"]') : null
    if (!target) return
    const label = String(target.textContent || '').replace(/\s+/g, '')
    if (label.includes('知识维护')) setTimeout(() => showEvolutionEntry(true), 120)
    if (label.includes('教务问答')) setTimeout(() => showEvolutionEntry(false), 120)
  }, true)
})()
