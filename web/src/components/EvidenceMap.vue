<script setup>
// 证据落图：回答卡片内的迷你地图，高亮被引用的讲解点/地点与提问锚点
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import L from 'leaflet'
import { store, mapLayers, gotoMap, openNote } from '../store.js'
import { baseStyle } from '../lib/palette.js'

const props = defineProps({
  anchor: { type: Array, default: null },     // [lon, lat]
  cites: { type: Array, default: () => [] },  // [{idx, nid, title, coord}]
})

const el = ref(null)
let map = null

function fc(feats) {
  return { type: 'FeatureCollection',
    features: feats.map(f => ({ type: 'Feature', geometry: f.g, properties: f.p })) }
}

function build() {
  if (!el.value) return
  if (map) { try { map.remove() } catch { /* 已销毁 */ } map = null }
  if (el.value._leaflet_id) { el.value._leaflet_id = undefined; el.value.innerHTML = '' }
  if (!el.value.clientWidth) return          // 尚未布局，等 onMounted/nextTick 再来
  const pts = props.cites.filter(c => c.coord)
  if (!pts.length && !props.anchor) return

  const s = baseStyle(store.isDark)
  map = L.map(el.value, {
    zoomControl: false, attributionControl: false, preferCanvas: true,
    dragging: true, scrollWheelZoom: false, tap: false,
    minZoom: 11, maxZoom: 16, zoomSnap: 0.5,
  })
  map.setView([29.556, 115.98], 12)   // 先给初始视图，矢量图层才能安全添加
  L.geoJSON(fc(mapLayers.water), {
    style: { color: s.waterLine, weight: 0.5, fillColor: s.water, fillOpacity: 0.75 },
    interactive: false,
  }).addTo(map)
  L.geoJSON(fc(mapLayers.roads), {
    style: f => ({ color: s.roadMinor, weight: f.properties.r === 'hw' ? 1.4 : 0.6, opacity: 0.6 }),
    interactive: false,
  }).addTo(map)

  const bounds = []
  for (const c of pts) {
    const ll = [c.coord[1], c.coord[0]]
    bounds.push(ll)
    L.marker(ll, {
      icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
        html: `<div class="ev-pin">${c.idx}</div>` }),
    }).on('click', () => openNote(c.nid)).addTo(map)
  }
  if (props.anchor) {
    const ll = [props.anchor[1], props.anchor[0]]
    bounds.push(ll)
    L.circleMarker(ll, { radius: 6, color: '#fff', weight: 2,
      fillColor: '#2a78d6', fillOpacity: 1 }).addTo(map)
  }
  try {
    if (bounds.length === 1) map.setView(bounds[0], 14)
    else map.fitBounds(L.latLngBounds(bounds).pad(0.35), { maxZoom: 15, animate: false })
  } catch { /* 保底视图已设置 */ }
}

function openBig() {
  const c = props.cites.find(x => x.coord)
  const coord = props.anchor || (c && c.coord)
  if (coord) gotoMap(coord, { zoom: 15 })
}

onMounted(() => nextTick(build))
watch(() => store.isDark, () => nextTick(build))
onBeforeUnmount(() => { if (map) { try { map.remove() } catch { /* ignore */ } map = null } })
</script>

<template>
  <div class="ev-wrap">
    <div ref="el" class="ev-map"></div>
    <button class="ev-open" @click="openBig" aria-label="在主地图中查看">⛶</button>
  </div>
</template>

<style>
.ev-wrap { position: relative; margin-top: 10px; }
.ev-map { height: 168px; border-radius: 12px; background: var(--map-bg);
  border: 1px solid var(--line-soft); overflow: hidden; }
.ev-open { position: absolute; right: 8px; top: 8px; z-index: 500;
  width: 30px; height: 30px; border-radius: 9px; background: var(--chip-bg);
  border: 1px solid var(--line); color: var(--ink-2); font-size: 15px;
  display: flex; align-items: center; justify-content: center; }
.ev-pin { width: 22px; height: 22px; border-radius: 50%; background: var(--pine);
  color: var(--pine-ink); font-size: 12px; font-weight: 700; font-family: var(--mono);
  display: flex; align-items: center; justify-content: center;
  border: 2px solid rgba(255,255,255,.9); box-shadow: 0 2px 6px rgba(0,0,0,.3); }
.is-dark .ev-pin { border-color: rgba(16,23,20,.8); }
</style>
