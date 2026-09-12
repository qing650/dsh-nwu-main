<script setup>
import { onMounted, onActivated, ref, reactive, watch, computed } from 'vue'
import { forceSimulation, forceManyBody, forceLink, forceX, forceY, forceCollide, forceRadial } from 'd3-force'
import { store, nodes, openNote, gotoMap } from '../store.js'
import { kindColor, KIND_ORDER } from '../lib/palette.js'

const cv = ref(null)
let ctx = null, W = 0, H = 0, dpr = 1
const view = { x: 0, y: 0, k: 1 }
let sim = null
let frozen = false
let userMoved = false          // 用户手动平移/缩放过就不再自动取景
let anim = null                // 视图动画句柄

// —— 数据准备 ——
const N = nodes.map(n => ({ ...n }))
const byId = Object.fromEntries(N.map(n => [n.id, n]))
const linkSet = new Set()
const links = []
for (const n of N) {
  for (const t of n.out || []) {
    if (!byId[t]) continue
    const key = n.id < t ? n.id + '|' + t : t + '|' + n.id
    if (linkSet.has(key)) continue
    linkSet.add(key)
    links.push({ source: n.id, target: t })
  }
}
const deg = {}
links.forEach(l => { deg[l.source] = (deg[l.source] || 0) + 1; deg[l.target] = (deg[l.target] || 0) + 1 })
const neighbors = {}
links.forEach(l => {
  ;(neighbors[l.source] = neighbors[l.source] || new Set()).add(l.target)
  ;(neighbors[l.target] = neighbors[l.target] || new Set()).add(l.source)
})

// 径向分层：索引居中；政策/通知在外层，指南/问答/解释依中心度分布（兼容旧地理站点类型）。
const RING = { 每日: 0, 索引: 0, 主线: 70, 讲解点: 150, 气象: 150, 概念: 265, 地点: 265, 物种: 345,
  通知公告: 150, 政策文件: 220, 办事指南: 300, 常见问题: 370, 名词解释: 430 }
function dayShort(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date || '')
  return m ? `${+m[1]}.${+m[2]}` : ''
}
N.forEach(n => {
  n.deg = deg[n.id] || 0
  n.r = Math.min(16, 3.5 + Math.sqrt(n.deg) * 1.7)
  n.ring = RING[n.k] ?? 265
  n.gl = n.k === '讲解点' ? String(n.n ?? '') : n.k === '每日' ? dayShort(n.date) : ''
  if (n.gl && n.k === '讲解点') n.r = Math.max(n.r, 9)
  if (n.k === '每日') n.r = Math.max(n.r, 13)
})

const kindsPresent = KIND_ORDER.filter(k => N.some(n => n.k === k))
const state = reactive({
  kinds: new Set(kindsPresent),
  selected: null,
  focusId: null,               // 聚焦模式：只显示该节点 1 跳邻域
  q: '',
  hinted: false,
})
const results = computed(() => {
  const q = state.q.trim()
  if (!q) return []
  return N.filter(n => n.t.includes(q) || n.id.includes(q)).slice(0, 14)
})
const selNode = computed(() => state.selected ? byId[state.selected] : null)
const focusNode = computed(() => state.focusId ? byId[state.focusId] : null)
const egoSet = computed(() => {
  if (!state.focusId) return null
  const s = new Set([state.focusId])
  for (const t of neighbors[state.focusId] || []) s.add(t)
  return s
})
// 选中节点的关联章片（按类型顺序、度数排序）
const selNeighbors = computed(() => {
  if (!selNode.value) return []
  const ids = [...(neighbors[selNode.value.id] || [])]
  const order = Object.fromEntries(KIND_ORDER.map((k, i) => [k, i]))
  return ids.map(id => byId[id])
    .filter(n => n && visible(n))
    .sort((a, b) => (order[a.k] ?? 9) - (order[b.k] ?? 9) || b.deg - a.deg)
    .slice(0, 24)
})

function visible(n) {
  if (!state.kinds.has(n.k)) return false
  if (egoSet.value && !egoSet.value.has(n.id)) return false
  return true
}

// —— 物理 ——
function startSim() {
  sim = forceSimulation(N)
    .force('charge', forceManyBody().strength(-95).distanceMax(380))
    .force('link', forceLink(links).id(d => d.id).distance(40).strength(.3))
    .force('radial', forceRadial(d => d.ring, 0, 0).strength(.07))
    .force('x', forceX(0).strength(.02))
    .force('y', forceY(0).strength(.02))
    .force('col', forceCollide().radius(d => d.r + 3.5))
    .on('tick', draw)
  sim.alphaMin(.025)
  sim.on('end', () => {
    frozen = true
    if (!userMoved) fitView(N.filter(visible))
    draw()
  })
}

// —— 视图动画 ——
function animateTo(tx, ty, tk, ms = 420) {
  if (anim) cancelAnimationFrame(anim)
  const f = { x: view.x, y: view.y, k: view.k }
  const t0 = performance.now()
  const ease = t => 1 - Math.pow(1 - t, 3)
  function step(now) {
    const p = Math.min(1, (now - t0) / ms), e = ease(p)
    view.x = f.x + (tx - f.x) * e
    view.y = f.y + (ty - f.y) * e
    view.k = f.k + (tk - f.k) * e
    draw()
    if (p < 1) anim = requestAnimationFrame(step)
  }
  anim = requestAnimationFrame(step)
}
function fitView(list, animate = true) {
  if (!list.length) return
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (const n of list) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r)
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r)
  }
  const pad = 46
  const k = Math.max(.3, Math.min(2.6,
    Math.min((W - pad * 2) / (x1 - x0 + 1), (H - pad * 2 - 120) / (y1 - y0 + 1))))
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  if (animate) animateTo(-cx * k, -cy * k, k)
  else { view.x = -cx * k; view.y = -cy * k; view.k = k; draw() }
}
function zoomAt(cx, cy, factor) {
  const k = Math.max(.25, Math.min(4.5, view.k * factor))
  const px = cx - W / 2, py = cy - H / 2
  const s = k / view.k
  animateTo(px - (px - view.x) * s, py - (py - view.y) * s, k, 260)
}

// —— 绘制 ——
function resize() {
  const el = cv.value
  if (!el) return
  dpr = window.devicePixelRatio || 1
  W = el.clientWidth; H = el.clientHeight
  el.width = W * dpr; el.height = H * dpr
  ctx = el.getContext('2d')
  draw()
}
function linkPath(a, b) {
  // 轻微弧线：中点沿法向偏移，方向由 id 序稳定决定
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  const d = Math.hypot(dx, dy) || 1
  const side = a.id < b.id ? 1 : -1
  const bend = Math.min(22, d * .14) * side
  ctx.moveTo(a.x, a.y)
  ctx.quadraticCurveTo(mx - dy / d * bend, my + dx / d * bend, b.x, b.y)
}
function draw() {
  if (!ctx) return
  const dark = store.isDark
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)
  ctx.translate(W / 2 + view.x, H / 2 + view.y)
  ctx.scale(view.k, view.k)

  const sel = state.selected
  const nb = sel ? neighbors[sel] || new Set() : null
  const inkDim = dark ? 'rgba(228,232,225,' : 'rgba(31,41,36,'

  // 分层参考环（聚焦模式下隐藏）
  if (!egoSet.value) {
    ctx.strokeStyle = inkDim + (dark ? '.06)' : '.05)')
    ctx.lineWidth = 1 / view.k
    ctx.setLineDash([4 / view.k, 7 / view.k])
    for (const r of [150, 265, 345]) {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // links（弧线，选中时三级层次）
  ctx.lineWidth = 1 / view.k
  if (!sel) {
    ctx.beginPath()
    for (const l of links) {
      if (!visible(l.source) || !visible(l.target)) continue
      linkPath(l.source, l.target)
    }
    ctx.strokeStyle = inkDim + (dark ? '.14)' : '.12)')
    ctx.stroke()
  } else {
    ctx.beginPath()
    for (const l of links) {
      if (!visible(l.source) || !visible(l.target)) continue
      if (l.source.id === sel || l.target.id === sel) continue
      linkPath(l.source, l.target)
    }
    ctx.strokeStyle = inkDim + '.05)'
    ctx.stroke()
    ctx.beginPath()
    for (const l of links) {
      if (l.source.id !== sel && l.target.id !== sel) continue
      if (!visible(l.source) || !visible(l.target)) continue
      linkPath(l.source, l.target)
    }
    ctx.lineWidth = 1.7 / view.k
    ctx.strokeStyle = inkDim + '.45)'
    ctx.stroke()
  }

  // 选中光晕
  if (sel && byId[sel] && visible(byId[sel])) {
    const n = byId[sel]
    const g = ctx.createRadialGradient(n.x, n.y, n.r, n.x, n.y, n.r + 22)
    const c = kindColor(n.k, dark)
    g.addColorStop(0, c + '55'); g.addColorStop(1, c + '00')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 22, 0, Math.PI * 2); ctx.fill()
  }

  // nodes
  for (const n of N) {
    if (!visible(n)) continue
    const dimmed = sel && n.id !== sel && !(nb && nb.has(n.id))
    ctx.globalAlpha = dimmed ? .15 : 1
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fillStyle = kindColor(n.k, dark)
    ctx.fill()
    if (n.id === sel) {
      ctx.lineWidth = 2.4 / view.k
      ctx.strokeStyle = dark ? '#e4e8e1' : '#1f2924'
      ctx.stroke()
    }
    // 徽标：讲解点编号 / 每日日期
    if (n.gl && !dimmed && n.r * view.k >= 7) {
      const fs = n.k === '每日' ? n.r * .62 : n.r * .95
      ctx.font = `700 ${fs}px ${getComputedStyle(document.body).fontFamily}`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,255,255,.94)'
      ctx.fillText(n.gl, n.x, n.y + fs * .06)
      ctx.textBaseline = 'alphabetic'
    }
  }
  ctx.globalAlpha = 1

  // labels：未选中时只标注枢纽，随缩放放开；聚焦模式全标
  const hubCut = egoSet.value ? 0 : view.k > 2.4 ? 0 : view.k > 1.7 ? 7 : view.k > 1.2 ? 14 : 22
  ctx.font = `${11 / view.k}px ${getComputedStyle(document.body).fontFamily}`
  ctx.textAlign = 'center'
  for (const n of N) {
    if (!visible(n)) continue
    const isSel = n.id === sel, isNb = nb && nb.has(n.id)
    if (!(isSel || isNb || (!sel && n.deg >= hubCut))) continue
    if (sel && !isSel && !isNb) continue
    if (isSel) ctx.font = `600 ${12 / view.k}px ${getComputedStyle(document.body).fontFamily}`
    const y = n.y + n.r + 11 / view.k
    ctx.lineWidth = 3 / view.k
    ctx.strokeStyle = dark ? 'rgba(16,23,20,.85)' : 'rgba(243,244,239,.9)'
    ctx.strokeText(n.t, n.x, y)
    ctx.fillStyle = isSel ? (dark ? '#e4e8e1' : '#1f2924') : inkDim + '.75)'
    ctx.fillText(n.t, n.x, y)
    if (isSel) ctx.font = `${11 / view.k}px ${getComputedStyle(document.body).fontFamily}`
  }
  ctx.restore()
}

// —— 交互：节点拖拽 / 平移 / 双指缩放 / 双击 / 点选 ——
const pts = new Map()
let moved = false, pinch0 = null, dragNode = null, lastTap = { t: 0, x: 0, y: 0 }

function toGraph(cx, cy) {
  const rect = cv.value.getBoundingClientRect()
  return [(cx - rect.left - W / 2 - view.x) / view.k,
          (cy - rect.top - H / 2 - view.y) / view.k]
}
function hitNode(cx, cy) {
  const [gx, gy] = toGraph(cx, cy)
  let best = null, bd = 1e9
  for (const n of N) {
    if (!visible(n)) continue
    const d = Math.hypot(n.x - gx, n.y - gy)
    if (d < Math.max(n.r + 6, 14 / view.k) && d < bd) { best = n; bd = d }
  }
  return best
}
function onDown(e) {
  state.hinted = true
  cv.value.setPointerCapture(e.pointerId)
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
  moved = false
  if (pts.size === 1) {
    dragNode = hitNode(e.clientX, e.clientY)
    if (dragNode) {
      dragNode.fx = dragNode.x; dragNode.fy = dragNode.y
      if (sim) { sim.alphaTarget(.28).restart(); frozen = false }
    }
  } else if (pts.size === 2) {
    if (dragNode) { dragNode.fx = dragNode.fy = null; dragNode = null; sim && sim.alphaTarget(0) }
    const [a, b] = [...pts.values()]
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k,
      vx: view.x, vy: view.y }
  }
}
function onMove(e) {
  if (!pts.has(e.pointerId)) return
  const prev = pts.get(e.pointerId)
  const cur = { x: e.clientX, y: e.clientY }
  pts.set(e.pointerId, cur)
  if (pts.size === 1) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y
    if (Math.abs(dx) + Math.abs(dy) > 2.5) moved = true
    if (dragNode) {
      const [gx, gy] = toGraph(cur.x, cur.y)
      dragNode.fx = gx; dragNode.fy = gy
      if (frozen) draw()
    } else {
      userMoved = true
      view.x += dx; view.y += dy
      draw()
    }
  } else if (pts.size === 2 && pinch0) {
    moved = true; userMoved = true
    const [a, b] = [...pts.values()]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const k = Math.max(.25, Math.min(4.5, pinch0.k * d / pinch0.d))
    const cx = (a.x + b.x) / 2 - W / 2, cy = (a.y + b.y) / 2 - H / 2
    const s = k / pinch0.k
    view.k = k
    view.x = cx - (cx - pinch0.vx) * s
    view.y = cy - (cy - pinch0.vy) * s
    draw()
  }
}
function onUp(e) {
  pts.delete(e.pointerId)
  if (pts.size < 2) pinch0 = null
  if (dragNode) {
    dragNode.fx = dragNode.fy = null
    dragNode = null
    if (sim) sim.alphaTarget(0)
    if (moved) return
  }
  if (pts.size === 0 && !moved) {
    const now = performance.now()
    const isDbl = now - lastTap.t < 320 &&
      Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30
    lastTap = { t: now, x: e.clientX, y: e.clientY }
    if (isDbl) {
      userMoved = true
      const rect = cv.value.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.75)
      return
    }
    const n = hitNode(e.clientX, e.clientY)
    state.selected = n ? n.id : null
    draw()
  }
}
function onWheel(e) {
  e.preventDefault()
  userMoved = true
  const rect = cv.value.getBoundingClientRect()
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.18 : .85)
}

function centerOn(id, select = true) {
  const n = byId[id]
  if (!n) return
  if (select) state.selected = id
  const k = Math.max(view.k, 1.5)
  animateTo(-n.x * k, -n.y * k, k)
}

// —— 聚焦模式 ——
function toggleFocus() {
  if (state.focusId === state.selected) {
    state.focusId = null
    fitView(N.filter(visible))
  } else {
    state.focusId = state.selected
    requestAnimationFrame(() => fitView(N.filter(visible)))
  }
}
function exitFocus() {
  state.focusId = null
  fitView(N.filter(visible))
}

function toggleKind(k) {
  if (state.kinds.has(k)) state.kinds.delete(k)
  else state.kinds.add(k)
  if (selNode.value && !state.kinds.has(selNode.value.k)) state.selected = null
  draw()
}
function pickResult(n) {
  state.q = ''
  if (state.focusId && !egoSet.value.has(n.id)) state.focusId = null
  centerOn(n.id)
}
function recenter() {
  userMoved = false
  fitView(N.filter(visible))
}

function consumeFocus() {
  if (store.graphFocus && byId[store.graphFocus]) {
    const id = store.graphFocus
    store.graphFocus = null
    if (state.focusId && !(neighbors[state.focusId] || new Set()).has(id) && state.focusId !== id) {
      state.focusId = null
    }
    setTimeout(() => centerOn(id), frozen ? 60 : 600)
  }
}

onMounted(() => {
  resize()
  startSim()
  window.addEventListener('resize', resize)
  consumeFocus()
  setTimeout(() => { state.hinted = true }, 6000)
})
onActivated(() => { resize(); consumeFocus() })
watch(() => store.graphFocus, consumeFocus)
watch(() => store.isDark, draw)
watch(() => state.focusId, draw)
</script>

<template>
  <div class="gwrap">
    <canvas ref="cv" class="gcv"
            @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp"
            @pointercancel="onUp" @wheel="onWheel"></canvas>

    <div class="gtop">
      <div class="gsearch">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/>
          <path d="m15.5 15.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <input v-model="state.q" :placeholder="`搜索 ${N.length} 条教务知识…`" aria-label="搜索教务知识条目" />
        <button v-if="state.q" aria-label="清空" @click="state.q = ''">✕</button>
      </div>
      <div v-if="results.length" class="gres card">
        <button v-for="n in results" :key="n.id" class="gres-i" @click="pickResult(n)">
          <span class="k-dot" :style="{ background: kindColor(n.k, store.isDark) }"></span>
          <span class="gres-t">{{ n.t }}</span>
          <span class="gres-k">{{ n.k }}</span>
        </button>
      </div>
      <div class="chip-row">
        <button v-for="k in kindsPresent" :key="k" class="chip"
                :class="{ on: state.kinds.has(k) }" @click="toggleKind(k)">
          <span class="dot" :style="{ background: kindColor(k, store.isDark) }"></span>{{ k }}
        </button>
      </div>
      <Transition name="fade">
        <button v-if="focusNode" class="gfocus chip on" @click="exitFocus">
          聚焦：{{ focusNode.t }}（{{ (egoSet?.size ?? 1) - 1 }} 个关联）✕
        </button>
      </Transition>
    </div>

    <div class="gfabs">
      <button class="fab" aria-label="自动取景" @click="recenter">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"
                fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
        </svg>
      </button>
    </div>

    <Transition name="fade">
      <div v-if="!state.hinted" class="ghint">拖动节点 · 双击放大 · 点选看关联</div>
    </Transition>

    <Transition name="fade">
      <div v-if="selNode" class="gcard card">
        <div class="gcard-h">
          <span class="k-dot" :style="{ background: kindColor(selNode.k, store.isDark) }"></span>
          <div class="gcard-tt">
            <div class="gcard-t">{{ selNode.t }}</div>
            <div class="gcard-m">{{ selNode.k }} · {{ selNode.deg }} 条关联<template v-if="selNode.date"> · {{ selNode.date }}</template></div>
          </div>
          <button class="gcard-x" aria-label="取消选中" @click="state.selected = null; draw()">✕</button>
        </div>
        <div v-if="selNeighbors.length" class="gnb chip-row">
          <button v-for="n in selNeighbors" :key="n.id" class="chip nb" @click="centerOn(n.id)">
            <span class="dot" :style="{ background: kindColor(n.k, store.isDark) }"></span>
            <span class="nb-t">{{ n.t }}</span>
          </button>
        </div>
        <div class="gcard-a">
          <button class="btn" @click="openNote(selNode.id)">打开条目</button>
          <button class="btn ghost" @click="toggleFocus">
            {{ state.focusId === selNode.id ? '退出聚焦' : '聚焦邻域' }}
          </button>
          <button v-if="selNode.c" class="btn ghost icon" aria-label="在地图上查看"
                  @click="gotoMap(selNode.c, { pointId: selNode.id })">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M3 19 9 5l4.2 9.2L15.5 10l5.5 9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gwrap { background:
  radial-gradient(1200px 600px at 70% -10%, color-mix(in srgb, var(--pine) 7%, transparent), transparent 60%),
  var(--paper); }
.gcv { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.gtop { position: absolute; top: calc(10px + env(safe-area-inset-top)); left: 10px; right: 10px;
  display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.gtop > * { pointer-events: auto; }
.gsearch { display: flex; align-items: center; gap: 8px; background: var(--chip-bg);
  border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px;
  color: var(--ink-3); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.gsearch input { flex: 1; border: none; background: none; outline: none; font-size: 14px;
  color: var(--ink); min-width: 0; }
.gsearch input::placeholder { color: var(--ink-3); }
.gres { padding: 4px; max-height: 44dvh; overflow-y: auto; box-shadow: var(--shadow); }
.gres-i { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: 8px; font-size: 14px; }
.gres-i:active { background: var(--card-2); }
.gres-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gres-k { font-size: 11px; color: var(--ink-3); }
.gfocus { align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.gfabs { position: absolute; right: 12px; bottom: 14px; display: flex; flex-direction: column; gap: 10px; }
.fab { width: 44px; height: 44px; border-radius: 14px; background: var(--chip-bg);
  border: 1px solid var(--line); color: var(--ink-2); display: flex; align-items: center;
  justify-content: center; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow); }
.ghint { position: absolute; left: 50%; transform: translateX(-50%); bottom: 18px;
  background: var(--chip-bg); border: 1px solid var(--line); color: var(--ink-2);
  font-size: 12.5px; padding: 7px 14px; border-radius: 999px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); pointer-events: none; }
.gcard { position: absolute; left: 12px; right: 64px; bottom: 14px; box-shadow: var(--shadow);
  padding: 12px 14px; }
.gcard-h { display: flex; align-items: flex-start; gap: 8px; }
.gcard-h .k-dot { margin-top: 6px; }
.gcard-tt { flex: 1; min-width: 0; }
.gcard-t { font-family: var(--serif); font-size: 16px; line-height: 1.4; }
.gcard-m { font-size: 12px; color: var(--ink-3); margin-top: 2px; }
.gcard-x { color: var(--ink-3); padding: 4px 6px; flex: none; }
.gnb { margin: 9px 0 1px; }
.chip.nb { padding: 5px 10px; font-size: 12px; }
.nb-t { max-width: 8.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gcard-a { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.btn.icon { padding: 8px 10px; }
</style>
