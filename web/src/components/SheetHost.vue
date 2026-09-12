<script setup>
import { computed, ref } from 'vue'
import { store, nodeById, days, openNote, gotoGraph, gotoMap } from '../store.js'
import { kindColor, dayColor } from '../lib/palette.js'
import NoteBody from './NoteBody.vue'
import PhotoStrip from './PhotoStrip.vue'

const sheet = computed(() => store.sheet)
const node = computed(() =>
  sheet.value?.type === 'note' ? nodeById[sheet.value.id] : null)
const point = computed(() => {
  if (sheet.value?.type !== 'point') return null
  const d = days[sheet.value.dayIdx]
  return { d, pt: d.points.find(p => p.n === sheet.value.n) }
})
const wxRow = computed(() => {
  const p = point.value
  if (!p || p.pt.wx == null || !p.d.wx) return null
  return p.d.wx.rows[p.pt.wx]
})

function close() { store.sheet = null }

// 下拉关闭
const el = ref(null)
let y0 = null, dy = 0
function ts(e) { y0 = e.touches[0].clientY; dy = 0 }
function tm(e) {
  if (y0 == null) return
  dy = Math.max(0, e.touches[0].clientY - y0)
  if (el.value) el.value.style.transform = `translateY(${dy}px)`
}
function te() {
  if (el.value) el.value.style.transform = ''
  if (dy > 90) close()
  y0 = null
}
</script>

<template>
  <Transition name="fade">
    <div v-if="sheet" class="sheet-mask" @click="close"></div>
  </Transition>
  <Transition name="sheet">
    <div v-if="sheet" ref="el" class="sheet" role="dialog" aria-modal="true">
      <div class="sh-head" @touchstart.passive="ts" @touchmove.passive="tm" @touchend.passive="te">
        <div class="sheet-grip"></div>

        <!-- 笔记 -->
        <template v-if="node">
          <div class="sh-eyebrow">
            <span class="k-dot" :style="{ background: kindColor(node.k, store.isDark) }"></span>
            <span class="eyebrow">{{ node.k }}<template v-if="node.day"> · {{ node.day }} 第{{ node.n }}点</template></span>
          </div>
          <h2 class="sh-title">{{ node.t }}</h2>
          <div v-if="node.time || node.alt" class="sh-meta mono">
            <span v-if="node.time">{{ node.time }}</span>
            <span v-if="node.alt">海拔 {{ node.alt }} m</span>
          </div>
        </template>

        <!-- 讲解点速览 -->
        <template v-else-if="point">
          <div class="sh-eyebrow">
            <span class="k-dot" :style="{ background: dayColor(sheet.dayIdx, store.isDark) }"></span>
            <span class="eyebrow">{{ point.d.short }} · 讲解点 {{ point.pt.n }}</span>
          </div>
          <h2 class="sh-title">{{ point.pt.title }}</h2>
          <div class="sh-meta mono">
            <span v-if="point.pt.time">{{ point.pt.time }}</span>
            <span v-if="point.pt.alt">海拔 {{ point.pt.alt }} m</span>
            <span v-if="point.pt.venue">{{ point.pt.venue }}</span>
          </div>
        </template>

        <!-- 要素信息 -->
        <template v-else-if="sheet.type === 'feature'">
          <div class="sh-eyebrow">
            <span class="k-dot" :style="{ background: sheet.color || 'var(--pine)' }"></span>
            <span class="eyebrow">{{ sheet.sub || '图层要素' }}</span>
          </div>
          <h2 class="sh-title">{{ sheet.title }}</h2>
        </template>

        <!-- 图例 -->
        <template v-else-if="sheet.type === 'legend'">
          <h2 class="sh-title">{{ sheet.title }}</h2>
        </template>
      </div>

      <div class="sheet-body">
        <template v-if="node">
          <div class="sh-actions" v-if="node.c">
            <button class="btn ghost" @click="gotoMap(node.c, { pointId: node.id })">在地图上查看</button>
            <button class="btn ghost" @click="gotoGraph(node.id)">在图谱中查看</button>
          </div>
          <NoteBody :md="node.md" />
        </template>

        <template v-else-if="point">
          <p v-if="point.pt.center" class="sh-center">{{ point.pt.center }}</p>
          <div v-if="wxRow" class="wx-strip mono">
            <span title="气温">{{ wxRow.T }}℃</span>
            <span title="相对湿度">{{ wxRow.RH }}%</span>
            <span title="气压">{{ wxRow.P }} hPa</span>
            <span v-if="wxRow.ws" title="风速">{{ wxRow.wd }} {{ wxRow.ws }} m/s</span>
          </div>
          <PhotoStrip :pids="point.pt.photos" :size="120" />
          <div class="sh-actions">
            <button class="btn" @click="openNote(point.pt.id)">完整讲解笔记</button>
            <button class="btn ghost" @click="gotoGraph(point.pt.id)">知识图谱</button>
          </div>
          <p v-if="point.pt.approx" class="sh-note">※ 该点位置为近似标注</p>
        </template>

        <template v-else-if="sheet.type === 'feature'">
          <dl class="feat">
            <template v-for="(r, i) in sheet.rows" :key="i">
              <div v-if="r[1]" class="feat-row">
                <dt>{{ r[0] }}</dt><dd>{{ r[1] }}</dd>
              </div>
            </template>
          </dl>
        </template>

        <template v-else-if="sheet.type === 'legend'">
          <div class="lg">
            <div v-for="it in sheet.items" :key="it.label" class="lg-row">
              <span class="lg-sw" :style="it.style"></span>
              <span class="lg-l">{{ it.label }}</span>
              <span v-if="it.extra" class="lg-e">{{ it.extra }}</span>
            </div>
          </div>
          <p v-if="sheet.note" class="sh-note">{{ sheet.note }}</p>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sh-head { padding: 0 18px 10px; border-bottom: 1px solid var(--line-soft); flex: none; }
.sh-eyebrow { display: flex; align-items: center; margin-top: 8px; }
.sh-title { font-family: var(--serif); font-size: 19px; line-height: 1.35;
  margin: 6px 0 0; text-wrap: balance; }
.sh-meta { display: flex; gap: 14px; font-size: 12.5px; color: var(--ink-2); margin-top: 6px; flex-wrap: wrap; }
.sh-center { color: var(--ink-2); font-size: 14px; margin: 10px 0 12px; line-height: 1.7; }
.sh-actions { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
.sh-note { font-size: 12px; color: var(--ink-3); margin-top: 10px; }
.wx-strip { display: flex; gap: 14px; font-size: 13px; color: var(--ink-2);
  background: var(--card-2); border-radius: 10px; padding: 8px 12px; margin-bottom: 12px;
  overflow-x: auto; white-space: nowrap; }
.feat { margin: 6px 0 0; }
.feat-row { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
.feat-row:last-child { border-bottom: none; }
.feat dt { flex: none; width: 64px; color: var(--ink-3); font-size: 13px; }
.feat dd { margin: 0; font-size: 14px; line-height: 1.65; }
.lg { display: flex; flex-direction: column; }
.lg-row { display: flex; align-items: center; gap: 10px; padding: 7px 0;
  border-bottom: 1px solid var(--line-soft); }
.lg-row:last-child { border-bottom: none; }
.lg-sw { width: 22px; height: 14px; border-radius: 4px; border: 1px solid var(--line); flex: none; }
.lg-l { font-size: 14px; }
.lg-e { margin-left: auto; font-size: 12px; color: var(--ink-3); }
</style>
