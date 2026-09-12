import { reactive, watchEffect } from 'vue'
import { loadAll, photoUrl } from './lib/api.js'

// 数据在启动时从后端拉取（不再打进 bundle）。
// 这些是 ESM 活绑定：initStore() 赋值后，所有 import 方都会看到新值。
// 组件的 setup 在 mount 之后才执行，而 mount 在 initStore 之后，所以读到的一定是已装载的数据。
export let site = null
export let nodes = []
export let nodeById = {}
export let days = []
export let mapLayers = {}
export let mapBounds = [0, 0, 0, 0]
export let photos = {}

let nameIndex = {}

export async function initStore() {
  const d = await loadAll()
  site = d.site
  nodes = d.graph.nodes
  nodeById = Object.fromEntries(nodes.map(n => [n.id, n]))
  days = d.days
  mapLayers = d.map.layers
  mapBounds = d.map.bounds
  photos = d.photos

  // 名称/别名 -> 节点 id（wikilink 解析用）
  nameIndex = {}
  for (const n of nodes) {
    nameIndex[n.id] = n.id
    if (n.t !== n.id) nameIndex[n.t] = n.id
  }
  return d
}

export function resolveNote(name) {
  return nameIndex[name] || null
}

/** 照片元信息 + URL（照片本体是后端静态文件，浏览器自己缓存） */
export function photoById(pid) {
  const p = photos[pid]
  return p ? { ...p, u: photoUrl(pid) } : null
}

const initTab = ['ask', 'graph'].includes(location.hash.slice(1))
  ? location.hash.slice(1) : 'ask'

export const store = reactive({
  tab: initTab,               // ask | graph
  isDark: false,
  // 地图
  mapTheme: 'geo',            // none | geo | soil | veg
  structOn: false,
  placesOn: true,
  dayFilter: 'all',           // all | 0709 | 0710 ...
  mapFocus: null,             // {coord:[x,y], zoom} 一次性
  // 图谱
  graphFocus: null,           // nodeId 一次性
  // 抽屉与灯箱
  sheet: null,                // {type:'point'|'feature'|'note', ...}
  lightbox: null,             // {pids:[], idx}
})

export function openNote(id) {
  const n = nodeById[id]
  if (!n) return
  store.sheet = { type: 'note', id }
}
export function gotoGraph(id) {
  store.sheet = null
  store.graphFocus = id
  store.tab = 'graph'
}
export function gotoMap(coord, opt = {}) {
  store.sheet = null
  store.mapFocus = { coord, zoom: opt.zoom || 15, pointId: opt.pointId || null }
  store.tab = 'map'
}
export function openLightbox(pids, idx = 0) {
  store.lightbox = { pids, idx }
}

// —— 主题（跟随系统 + 宿主 data-theme 覆盖） ——
const mq = window.matchMedia('(prefers-color-scheme: dark)')
function themeNow() {
  const t = document.documentElement.dataset.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return mq.matches
}
store.isDark = themeNow()
mq.addEventListener('change', () => { store.isDark = themeNow() })
new MutationObserver(() => { store.isDark = themeNow() })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

watchEffect(() => {
  document.documentElement.classList.toggle('is-dark', store.isDark)
})
watchEffect(() => {
  try { history.replaceState(null, '', '#' + store.tab) } catch (e) { /* 沙箱环境忽略 */ }
})
