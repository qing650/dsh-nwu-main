<script setup>
// 气压—高程 散点 + 线性拟合。单序列：标题即图例；点击/触点显示读数。
import { computed, ref } from 'vue'
import { store } from '../store.js'

const props = defineProps({ rows: Array, fit: Object })

const W = 340, H = 190
const M = { l: 44, r: 14, t: 12, b: 30 }

const data = computed(() => (props.rows || [])
  .map(r => ({ ...r, h: parseFloat(r.alt), p: parseFloat(r.P) }))
  .filter(r => isFinite(r.h) && isFinite(r.p)))

const ext = computed(() => {
  const hs = data.value.map(d => d.h), ps = data.value.map(d => d.p)
  const pad = (a, f) => { const lo = Math.min(...a), hi = Math.max(...a); const p = (hi - lo || 10) * f; return [lo - p, hi + p] }
  return { h: pad(hs, .12), p: pad(ps, .18) }
})
const sx = v => M.l + (v - ext.value.h[0]) / (ext.value.h[1] - ext.value.h[0]) * (W - M.l - M.r)
const sy = v => H - M.b - (v - ext.value.p[0]) / (ext.value.p[1] - ext.value.p[0]) * (H - M.t - M.b)

function ticks([lo, hi], n) {
  const step = niceStep((hi - lo) / n)
  const t = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) t.push(+v.toFixed(6))
  return t
}
function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const r = raw / mag
  return (r >= 5 ? 10 : r >= 2 ? 5 : r >= 1 ? 2 : 1) * mag
}
const xt = computed(() => ticks(ext.value.h, 4))
const yt = computed(() => ticks(ext.value.p, 3))

const fitPts = computed(() => {
  if (!props.fit) return null
  const { a, b } = props.fit
  const [h0, h1] = ext.value.h
  return { x1: sx(h0), y1: sy(a - b * h0), x2: sx(h1), y2: sy(a - b * h1) }
})

const sel = ref(null)
function pick(d) { sel.value = sel.value === d ? null : d }
const accent = computed(() => store.isDark ? '#3987e5' : '#2a78d6')
</script>

<template>
  <div v-if="data.length" class="wxc">
    <svg :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="气压随高程变化散点图">
      <!-- 网格（退居背景） -->
      <g stroke="var(--line-soft)">
        <line v-for="t in yt" :key="'y'+t" :x1="M.l" :x2="W-M.r" :y1="sy(t)" :y2="sy(t)" />
      </g>
      <!-- 轴 -->
      <g class="ax mono" fill="var(--ink-3)" font-size="9.5">
        <text v-for="t in yt" :key="'yl'+t" :x="M.l-6" :y="sy(t)+3" text-anchor="end">{{ t }}</text>
        <text v-for="t in xt" :key="'xl'+t" :x="sx(t)" :y="H-M.b+14" text-anchor="middle">{{ t }}</text>
        <text :x="M.l-6" :y="M.t-2" text-anchor="end" font-size="8.5">hPa</text>
        <text :x="W-M.r" :y="H-M.b+14" text-anchor="end" font-size="8.5" dx="0" dy="11">海拔/m</text>
      </g>
      <!-- 拟合线 -->
      <line v-if="fitPts" v-bind="fitPts" :stroke="accent" stroke-width="1.6"
            stroke-dasharray="5 4" opacity=".65" />
      <!-- 数据点（含放大热区） -->
      <g v-for="d in data" :key="d.time + d.loc">
        <circle :cx="sx(d.h)" :cy="sy(d.p)" r="12" fill="transparent" @click="pick(d)" />
        <circle :cx="sx(d.h)" :cy="sy(d.p)" :r="sel === d ? 6 : 4.5" :fill="accent"
                stroke="var(--card)" stroke-width="2" pointer-events="none" />
      </g>
    </svg>
    <div class="wx-tip" :class="{ show: sel }">
      <template v-if="sel">
        <strong>{{ sel.loc }}</strong>
        <span class="mono">{{ sel.time }} · {{ sel.alt }} m · {{ sel.P }} hPa · {{ sel.T }}℃ · RH {{ sel.RH }}%</span>
      </template>
      <template v-else><span class="hint">点按数据点查看测点读数</span></template>
    </div>
    <div v-if="fit" class="wx-fit mono">
      P = {{ fit.a }} − {{ fit.b }} H<span v-if="fit.r2">　r² = {{ fit.r2 }}</span>
    </div>
  </div>
</template>

<style scoped>
.wxc svg { width: 100%; height: auto; display: block; }
.wx-tip { min-height: 34px; font-size: 12.5px; color: var(--ink-2);
  display: flex; flex-direction: column; gap: 1px; padding: 4px 2px; }
.wx-tip strong { color: var(--ink); font-size: 13px; }
.wx-tip .hint { color: var(--ink-3); }
.wx-fit { font-size: 12px; color: var(--ink-3); padding: 2px; }
</style>
