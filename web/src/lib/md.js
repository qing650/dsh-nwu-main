// Obsidian 风格 Markdown -> HTML：wikilink、callout、照片 token、表格横向滚动
import { marked } from 'marked'
import { photoById } from '../store.js'

marked.setOptions({ gfm: true, breaks: false })

const CALLOUT_ICONS = {
  info: 'ⓘ', abstract: '§', note: '✎', tip: '☘', warning: '⚠', question: '?',
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 把 > [!type] Title 及后续引用行转成 callout div（在 marked 之前处理）
function callouts(md) {
  const lines = md.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/^>\s*\[!(\w+)\][+-]?\s*(.*)$/)
    if (m) {
      const body = []
      i++
      while (i < lines.length && /^>/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      const kind = m[1].toLowerCase()
      const icon = CALLOUT_ICONS[kind] || 'ⓘ'
      const title = m[2] ? `<div class="co-t"><span class="co-i">${icon}</span>${esc(m[2])}</div>` : ''
      out.push(`<div class="callout co-${kind}">${title}<div class="co-b">\n\n${body.join('\n')}\n\n</div></div>`)
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

// [[目标|别名]] -> 可点击链接（resolve 判断目标是否存在）
function wikilinks(md, resolve) {
  return md.replace(/\[\[([^\]]+?)\]\]/g, (_, inner) => {
    inner = inner.replace(/\\\|/g, '|')
    const [rawT, alias] = inner.split('|')
    const target = rawT.split('#')[0].trim()
    const label = (alias || rawT).trim()
    const id = resolve ? resolve(target) : null
    if (id) return `<a class="wl" data-wl="${esc(id)}">${esc(label)}</a>`
    return `<span class="wl-dead">${esc(label)}</span>`
  })
}

function photoTokens(md) {
  return md.replace(/\{\{photo:([^}]+)\}\}/g, (_, pid) => {
    const p = photoById(pid)
    if (!p) return ''
    return `<figure class="mdph"><img src="${p.u}" data-pid="${esc(pid)}" alt="${esc(p.c || '')}" loading="lazy"><figcaption>${esc(p.c || '')}</figcaption></figure>`
  })
}

export function renderMd(md, { resolve, dropH1 = true } = {}) {
  if (!md) return ''
  let s = md
  if (dropH1) s = s.replace(/^#\s+[^\n]*\n/m, '')
  s = callouts(s)
  s = photoTokens(s)
  s = wikilinks(s, resolve)
  let html = marked.parse(s)
  // 表格套横向滚动容器，避免撑破手机屏幕
  html = html.replace(/<table>/g, '<div class="tbl"><table>')
             .replace(/<\/table>/g, '</table></div>')
  return html
}

export { photoById }
