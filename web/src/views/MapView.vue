<script setup>
import { onMounted, onActivated, ref, watch, nextTick } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { store, site, days, mapLayers, mapBounds, openNote } from '../store.js'
import { ERA_COLORS, ERA_ORDER, SOIL_COLORS, VEG_COLORS, baseStyle, dayColor } from '../lib/palette.js'

const el = ref(null)
let map = null
let themeGroup, structGroup, baseGroup, routeGroup, markerGroup, placeGroup, peakGroup, poiGroup
let locMarker = null

const THEMES = [
  { id: 'none', label: '底图' },
  { id: 'geo', label: '地质' },
  { id: 'soil', label: '土壤' },
  { id: 'veg', label: '植被' },
]

function fc(feats) {
  return { type: 'FeatureCollection',
    features: feats.map(f => ({ type: 'Feature', geometry: f.g, properties: f.p })) }
}
const S = () => baseStyle(store.isDark)

// —————— 底图 ——————
function buildBase() {
  if (baseGroup) baseGroup.remove()
  const s = S()
  baseGroup = L.layerGroup()

  L.geoJSON(fc(mapLayers.water), {
    pane: 'water',
    style: { color: s.waterLine, weight: .7, fillColor: s.water, fillOpacity: .85 },
    onEachFeature: (f, ly) => {
      if (f.properties.n) ly.on('click', () => {
        store.sheet = { type: 'feature', title: f.properties.n, sub: '水体', color: s.river, rows: [] }
      })
    },
  }).addTo(baseGroup)

  L.geoJSON(fc(mapLayers.rivers), {
    pane: 'water', style: { color: s.river, weight: 1.1, opacity: .9 }, interactive: false,
  }).addTo(baseGroup)

  const rw = { hw: 3, major: 2.2, road: 1.8, minor: 1 }
  const rc = { hw: s.roadHw, major: s.roadMajor, road: s.roadRoad, minor: s.roadMinor }
  L.geoJSON(fc(mapLayers.roads), {
    pane: 'roads', interactive: false,
    style: f => ({ color: rc[f.properties.r], weight: rw[f.properties.r], opacity: .9 }),
  }).addTo(baseGroup)

  L.geoJSON(fc(mapLayers.boundary), {
    pane: 'struct', interactive: false,
    style: { color: s.boundary, weight: 1.6, dashArray: '7 5', fill: false, opacity: .8 },
  }).addTo(baseGroup)

  baseGroup.addTo(map)
}

// —————— 专题层 ——————
function buildTheme() {
  if (themeGroup) { themeGroup.remove(); themeGroup = null }
  const t = store.mapTheme
  if (t === 'none') return
  const s = S()
  const fill = store.isDark ? .48 : .62
  let feats, colorOf, sheetOf
  if (t === 'geo') {
    feats = mapLayers.geology
    colorOf = p => ERA_COLORS[p.e] || ERA_COLORS.未定
    sheetOf = p => ({ type: 'feature', title: p.n || p.s || '地质体', sub: `地质 · ${p.e}`,
      color: colorOf(p),
      rows: [['符号', p.s], ['时代', p.e], ['岩性', p.d], ['变质', p.m && p.m !== '无' ? p.m : '']] })
  } else if (t === 'soil') {
    feats = mapLayers.soil
    colorOf = p => SOIL_COLORS[p.g] || SOIL_COLORS.其他
    sheetOf = p => ({ type: 'feature', title: p.n, sub: '土壤类型', color: colorOf(p), rows: [] })
  } else {
    feats = mapLayers.vegetation
    colorOf = p => VEG_COLORS[p.n] || VEG_COLORS.未知
    sheetOf = p => ({ type: 'feature', title: p.n, sub: '植被 · 优势树种', color: colorOf(p), rows: [] })
  }
  themeGroup = L.geoJSON(fc(feats), {
    pane: 'theme',
    style: f => ({ color: s.inkDim, weight: .5, opacity: .5,
      fillColor: colorOf(f.properties), fillOpacity: fill }),
    onEachFeature: (f, ly) => ly.on('click', () => { store.sheet = sheetOf(f.properties) }),
  }).addTo(map)
}

// —————— 构造层 ——————
function buildStruct() {
  if (structGroup) { structGroup.remove(); structGroup = null }
  if (!store.structOn) return
  const s = S()
  structGroup = L.layerGroup()
  L.geoJSON(fc(mapLayers.faults), {
    pane: 'struct',
    style: { color: s.fault, weight: 1.8, opacity: .9 },
    onEachFeature: (f, ly) => ly.on('click', () => {
      const p = f.properties
      store.sheet = { type: 'feature', title: p.n ? `${p.n}断层` : '断层', sub: '构造 · 断层',
        color: s.fault, rows: [['类型', p.t], ['特征', p.f], ['时期', p.a]] }
    }),
  }).addTo(structGroup)
  L.geoJSON(fc(mapLayers.folds), {
    pane: 'struct',
    style: f => ({ color: s.fold, weight: 2,
      dashArray: f.properties.k === 'syn' ? '2 6' : null, opacity: .9 }),
    onEachFeature: (f, ly) => ly.on('click', () => {
      const p = f.properties
      store.sheet = { type: 'feature', title: p.n || '褶皱轴迹',
        sub: `构造 · ${p.k === 'syn' ? '向斜' : '背斜'}`, color: s.fold, rows: [['轴向', p.a]] }
    }),
  }).addTo(structGroup)
  L.geoJSON(fc(mapLayers.attitude), {
    pane: 'struct', style: { color: s.attitude, weight: 1.6, opacity: .85 },
    onEachFeature: (f, ly) => ly.on('click', () => {
      const p = f.properties
      store.sheet = { type: 'feature', title: `产状 ${p.d} ∠${p.a}°`, sub: `构造 · ${p.t}`,
        color: s.attitude, rows: [['倾向', p.d], ['倾角', p.a + '°']] }
    }),
  }).addTo(structGroup)
  structGroup.addTo(map)
}

// —————— 讲解点与路线 ——————
function buildRoute() {
  if (routeGroup) routeGroup.remove()
  if (markerGroup) markerGroup.remove()
  routeGroup = L.layerGroup().addTo(map)
  markerGroup = L.layerGroup().addTo(map)
  days.forEach((d, di) => {
    if (store.dayFilter !== 'all' && store.dayFilter !== d.key) return
    const c = dayColor(di, store.isDark)
    const coords = d.points.filter(p => p.coord).map(p => [p.coord[1], p.coord[0]])
    if (coords.length > 1) {
      L.polyline(coords, { pane: 'route', color: c, weight: 2.6, dashArray: '7 6',
        opacity: .85 }).addTo(routeGroup)
    }
    d.points.forEach(p => {
      if (!p.coord) return
      const ic = L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div class="jd-pin" style="--c:${c}">${p.n}</div>` })
      L.marker([p.coord[1], p.coord[0]], { icon: ic, zIndexOffset: 500 })
        .on('click', () => { store.sheet = { type: 'point', dayIdx: di, n: p.n } })
        .addTo(markerGroup)
    })
  })
}

// —————— 山峰 / POI / 知识地点 ——————
function labelIcon(html, cls) {
  return L.divIcon({ className: '', html: `<div class="${cls}">${html}</div>`,
    iconSize: null })
}
function buildDecor() {
  if (peakGroup) peakGroup.remove()
  if (poiGroup) poiGroup.remove()
  if (placeGroup) placeGroup.remove()
  peakGroup = L.layerGroup(); poiGroup = L.layerGroup(); placeGroup = L.layerGroup()
  const z = map.getZoom()
  if (z >= 13) {
    mapLayers.peaks.forEach(p => {
      L.marker([p.y, p.x], { icon: labelIcon(`▲<span>${p.n}</span>`, 'peak-l'),
        interactive: false, keyboard: false }).addTo(peakGroup)
    })
  }
  if (z >= 14) {
    mapLayers.pois.forEach(p => {
      const glyph = p.k === 'base' ? '⌂' : p.k === 'spring' ? '≈' : '·'
      L.marker([p.y, p.x], { icon: labelIcon(`${glyph}<span>${p.n}</span>`, 'poi-l'), keyboard: false })
        .on('click', () => {
          store.sheet = { type: 'feature', title: p.n,
            sub: p.k === 'base' ? '驻地' : p.k === 'spring' ? '泉·瀑' : '景点', rows: [] }
        })
        .addTo(poiGroup)
    })
  }
  if (store.placesOn && z >= 13) {
    mapLayers.places.forEach(p => {
      L.marker([p.y, p.x], { icon: labelIcon(`◈<span>${p.n}</span>`, 'place-l'), keyboard: false })
        .on('click', () => openNote(p.id))
        .addTo(placeGroup)
    })
  }
  peakGroup.addTo(map); poiGroup.addTo(map); placeGroup.addTo(map)
}

// —————— 图例 ——————
function showLegend() {
  const t = store.mapTheme
  let title = '图例', items = [], note = ''
  const sw = c => ({ background: c })
  if (t === 'geo') {
    title = '地质年代图例'
    const present = new Set(mapLayers.geology.map(f => f.p.e))
    items = ERA_ORDER.filter(e => present.has(e)).map(e => ({ label: e, style: sw(ERA_COLORS[e]) }))
    note = '点按图上色块可查看地层符号与岩性描述。'
  } else if (t === 'soil') {
    title = '土壤图例'
    const cnt = {}
    mapLayers.soil.forEach(f => { cnt[f.p.g] = (cnt[f.p.g] || 0) + 1 })
    items = Object.keys(SOIL_COLORS).filter(g => cnt[g])
      .map(g => ({ label: g, style: sw(SOIL_COLORS[g]), extra: cnt[g] + ' 片' }))
  } else if (t === 'veg') {
    title = '植被图例（优势树种）'
    const cnt = {}
    mapLayers.vegetation.forEach(f => { cnt[f.p.n] = (cnt[f.p.n] || 0) + 1 })
    items = Object.keys(VEG_COLORS).filter(g => cnt[g])
      .map(g => ({ label: g, style: sw(VEG_COLORS[g]), extra: cnt[g] + ' 片' }))
  } else {
    title = '底图图例'
  }
  const s = S()
  if (store.structOn) {
    items.push(
      { label: '断层', style: { background: 'transparent', borderTop: `2.5px solid ${s.fault}`, height: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' } },
      { label: '背斜轴迹', style: { background: 'transparent', borderTop: `2.5px solid ${s.fold}`, height: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' } },
      { label: '向斜轴迹（虚线）', style: { background: 'transparent', borderTop: `2.5px dotted ${s.fold}`, height: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' } },
      { label: '岩层产状（短线段）', style: { background: 'transparent', borderTop: `2px solid ${s.attitude}`, height: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' } },
    )
  }
  items.push({ label: '研究区边界（虚线）', style: { background: 'transparent', borderTop: `2px dashed ${s.boundary}`, height: 0, borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none' } })
  days.forEach((d, i) => items.push({ label: `${d.short} 路线与讲解点`, style: sw(dayColor(i, store.isDark)) }))
  store.sheet = { type: 'legend', title, items, note }
}

// —————— 定位 ——————
const locating = ref(false)
const toast = ref('')
function locate() {
  if (!navigator.geolocation) { flash('设备不支持定位'); return }
  locating.value = true
  navigator.geolocation.getCurrentPosition(pos => {
    locating.value = false
    const { latitude: la, longitude: lo } = pos.coords
    if (locMarker) locMarker.remove()
    locMarker = L.circleMarker([la, lo], { pane: 'route', radius: 7, color: '#fff',
      weight: 2.5, fillColor: '#2a78d6', fillOpacity: 1 }).addTo(map)
    map.flyTo([la, lo], Math.max(map.getZoom(), 15))
  }, err => {
    locating.value = false
    flash(err.code === 1 ? '定位权限被拒绝' : '定位失败，野外信号可能不佳')
  }, { enableHighAccuracy: true, timeout: 12000 })
}
let toastTimer = null
function flash(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 2600)
}

function fitToRoutes() {
  const pts = []
  days.forEach(d => d.points.forEach(p => { if (p.coord) pts.push([p.coord[1], p.coord[0]]) }))
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.18))
  else map.fitBounds([[mapBounds[1], mapBounds[0]], [mapBounds[3], mapBounds[2]]])
}

onMounted(() => {
  map = L.map(el.value, {
    zoomControl: false, attributionControl: false, preferCanvas: true,
    minZoom: 11, maxZoom: 17, zoomSnap: .5,
    maxBounds: [[mapBounds[1] - .12, mapBounds[0] - .12], [mapBounds[3] + .12, mapBounds[2] + .12]],
  })
  const paneZ = { theme: 320, water: 340, roads: 350, struct: 360, route: 400 }
  for (const [n, z] of Object.entries(paneZ)) {
    map.createPane(n).style.zIndex = z
    if (n !== 'route') map.getPane(n).style.pointerEvents = 'auto'
  }
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map)
  fitToRoutes()
  buildBase(); buildTheme(); buildStruct(); buildRoute(); buildDecor()
  map.on('zoomend', buildDecor)
})

onActivated(() => { if (map) { map.invalidateSize(); consumeFocus() } })

watch(() => store.mapTheme, buildTheme)
watch(() => store.structOn, buildStruct)
watch(() => store.placesOn, buildDecor)
watch(() => store.dayFilter, buildRoute)
watch(() => store.isDark, () => { buildBase(); buildTheme(); buildStruct(); buildRoute(); buildDecor() })
watch(() => store.mapFocus, consumeFocus)

function consumeFocus() {
  const f = store.mapFocus
  if (!f || !map) return
  store.mapFocus = null
  nextTick(() => {
    map.invalidateSize()
    map.flyTo([f.coord[1], f.coord[0]], f.zoom || 15, { duration: .9 })
    if (f.pointId) {
      for (let di = 0; di < days.length; di++) {
        const pt = days[di].points.find(p => p.id === f.pointId)
        if (pt) { store.sheet = { type: 'point', dayIdx: di, n: pt.n }; break }
      }
    }
  })
}
</script>

<template>
  <div class="map-wrap">
    <div ref="el" class="map"></div>

    <div class="brand" aria-hidden="true">
      <span class="brand-seal"></span>
      <span class="brand-t">{{ site.brand }}</span>
    </div>

    <div class="ctl top">
      <div class="chip-row">
        <button v-for="t in THEMES" :key="t.id" class="chip"
                :class="{ on: store.mapTheme === t.id }"
                @click="store.mapTheme = t.id">{{ t.label }}</button>
        <button class="chip" :class="{ on: store.structOn }"
                @click="store.structOn = !store.structOn">构造</button>
        <button class="chip" :class="{ on: store.placesOn }"
                @click="store.placesOn = !store.placesOn">知识地点</button>
      </div>
      <div class="chip-row">
        <button class="chip" :class="{ on: store.dayFilter === 'all' }"
                @click="store.dayFilter = 'all'">全部行程</button>
        <button v-for="(d, i) in days" :key="d.key" class="chip"
                :class="{ on: store.dayFilter === d.key }"
                @click="store.dayFilter = d.key">
          <span class="dot" :style="{ background: dayColor(i, store.isDark) }"></span>{{ d.short }}
        </button>
        <button class="chip" @click="showLegend">图例</button>
      </div>
    </div>

    <div class="ctl fabs">
      <button class="fab" :class="{ busy: locating }" aria-label="定位到我" @click="locate">
        <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" fill="currentColor"/>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/>
        </svg>
      </button>
      <button class="fab" aria-label="回到行程范围" @click="fitToRoutes">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"
                fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="credit">{{ site.credit }}</div>
    <Transition name="fade"><div v-if="toast" class="toast">{{ toast }}</div></Transition>
  </div>
</template>

<style>
.map-wrap { display: flex; flex-direction: column; }
.map { position: absolute; inset: 0; background: var(--map-bg); z-index: 0; }
.map-wrap .brand {
  position: absolute; top: calc(12px + env(safe-area-inset-top)); left: 10px; z-index: 30;
  writing-mode: vertical-rl; display: flex; align-items: center; gap: 8px;
  pointer-events: none;
}
.brand-t { font-family: var(--serif); font-size: 17px; letter-spacing: .3em;
  color: var(--ink); text-shadow: 0 0 6px var(--paper), 0 0 12px var(--paper); }
.brand-seal { width: 12px; height: 12px; background: var(--seal); border-radius: 2.5px;
  margin-bottom: 2px; }
.ctl.top { position: absolute; top: calc(10px + env(safe-area-inset-top)); left: 44px; right: 0;
  z-index: 30; display: flex; flex-direction: column; gap: 8px; padding-right: 10px; }
.ctl.fabs { position: absolute; right: 12px; bottom: 86px; z-index: 30;
  display: flex; flex-direction: column; gap: 10px; }
.fab { width: 44px; height: 44px; border-radius: 14px; background: var(--chip-bg);
  border: 1px solid var(--line); color: var(--ink-2); display: flex; align-items: center;
  justify-content: center; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow); }
.fab.busy { color: var(--pine); animation: pulse 1s ease infinite; }
@keyframes pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .fab.busy { animation: none; } }
.credit { position: absolute; left: 10px; bottom: 6px; z-index: 30; font-size: 10px;
  color: var(--ink-3); pointer-events: none; }
.toast { position: absolute; left: 50%; transform: translateX(-50%); bottom: 100px;
  background: var(--ink); color: var(--paper); font-size: 13px; padding: 8px 16px;
  border-radius: 10px; z-index: 40; }

/* Leaflet 皮肤与标注（全局作用域，Leaflet 动态创建 DOM） */
.leaflet-container { font-family: var(--sans); }
.leaflet-control-scale-line { background: var(--chip-bg); color: var(--ink-2);
  border-color: var(--line); font-size: 10px; }
.jd-pin { width: 26px; height: 26px; border-radius: 50%; background: var(--c);
  color: #fff; font-size: 13px; font-weight: 700; display: flex; align-items: center;
  justify-content: center; border: 2px solid rgba(255,255,255,.92);
  box-shadow: 0 2px 8px rgba(0,0,0,.35); font-family: var(--mono); }
.is-dark .jd-pin { border-color: rgba(16,23,20,.8); }
.peak-l, .poi-l, .place-l { display: flex; align-items: center; gap: 3px;
  font-size: 11px; white-space: nowrap; transform: translate(-6px, -8px);
  color: var(--ink-2); text-shadow: 0 0 4px var(--paper), 0 0 8px var(--paper), 0 0 2px var(--paper); }
.is-dark .peak-l, .is-dark .poi-l, .is-dark .place-l {
  text-shadow: 0 0 4px var(--map-bg), 0 0 8px var(--map-bg); }
.peak-l { color: var(--ink-2); font-weight: 600; }
.poi-l { color: var(--ink-3); }
.place-l { color: var(--pine); font-weight: 500; }
.peak-l span, .poi-l span, .place-l span { font-size: 11px; }
</style>
