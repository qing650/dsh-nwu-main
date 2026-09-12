<script setup>
import { ref, computed } from 'vue'
import { store, days, openNote, gotoMap, gotoGraph } from '../store.js'
import { dayColor } from '../lib/palette.js'
import WxChart from '../components/WxChart.vue'
import PhotoStrip from '../components/PhotoStrip.vue'
import NoteBody from '../components/NoteBody.vue'

const di = ref(days.length - 1)
const d = computed(() => days[di.value])
const c = computed(() => dayColor(di.value, store.isDark))
const showWxTable = ref(false)
const showRoadside = ref(false)

const photoCount = computed(() =>
  d.value.points.reduce((s, p) => s + p.photos.length, 0) + d.value.roadPhotos.length)

function dayNum(short) {
  const [m, dd] = short.split('.')
  return `${m}·${dd}`
}
</script>

<template>
  <div class="dwrap">
    <header class="dhead">
      <div class="eyebrow">Legacy Field Journal · 旧示例日志</div>
      <div class="dtabs" role="tablist" aria-label="选择日期">
        <button v-for="(dd, i) in days" :key="dd.key" class="dtab" role="tab"
                :class="{ on: di === i }" :aria-selected="di === i"
                :style="di === i ? { '--dc': dayColor(i, store.isDark) } : {}"
                @click="di = i; showWxTable = false; showRoadside = false">
          <span class="dtab-n">{{ dayNum(dd.short) }}</span>
          <span class="dtab-w">{{ dd.week }}</span>
        </button>
      </div>
    </header>

    <div class="dscroll">
      <!-- 概览 -->
      <section class="dhero">
        <div class="dhero-top">
          <div class="dhero-num" :style="{ color: c }">{{ dayNum(d.short) }}</div>
          <div class="dhero-meta">
            <div class="mono">{{ d.date }} {{ d.week }}</div>
            <div class="dhero-stats mono">
              <span>{{ d.points.length }} 讲解点</span>
              <span v-if="d.altRange">海拔 {{ d.altRange.replace(/\s*m$/, '') }} m</span>
              <span>{{ photoCount }} 照片</span>
              <span v-if="d.wx && d.wx.rows.length">{{ d.wx.rows.length }} 气象测点</span>
            </div>
          </div>
        </div>
        <div v-if="d.route" class="droute">{{ d.route.replace(/—/g, ' — ') }}</div>
        <p v-if="d.summary" class="dsum">{{ d.summary }}</p>
      </section>

      <!-- 气象 -->
      <section v-if="d.wx && d.wx.rows.length" class="card dsec">
        <h3 class="dsec-t">气压—高程 · 当日气象</h3>
        <p v-if="d.wx.intro" class="dsec-sub">{{ d.wx.intro }}</p>
        <WxChart :rows="d.wx.rows" :fit="d.wx.fit" />
        <button class="fold" @click="showWxTable = !showWxTable">
          {{ showWxTable ? '收起' : '展开' }}全部测点读数 {{ showWxTable ? '▴' : '▾' }}
        </button>
        <div v-if="showWxTable" class="tblw">
          <table class="mono">
            <thead><tr><th>测点</th><th>时刻</th><th>海拔</th><th>hPa</th><th>℃</th><th>RH%</th><th>风</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in d.wx.rows" :key="i">
                <td class="tloc">{{ r.loc }}</td><td>{{ r.time }}</td><td>{{ r.alt }}</td>
                <td>{{ r.P }}</td><td>{{ r.T }}</td><td>{{ r.RH }}</td>
                <td>{{ r.wd }} {{ r.ws }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="fold ghostlink" @click="openNote(d.wx.noteId)">查看气象分析笔记 →</button>
      </section>

      <!-- 讲解点时间线 -->
      <section class="dsec">
        <h3 class="dsec-t out">讲解点时间线</h3>
        <ol class="tl" :style="{ '--dc': c }">
          <li v-for="p in d.points" :key="p.n" class="tl-i">
            <div class="tl-badge mono">{{ p.n }}</div>
            <div class="tl-card card">
              <div class="tl-time mono">
                {{ p.time || '—' }}<template v-if="p.alt"> · {{ p.alt }} m</template>
                <template v-if="p.venue"> · {{ p.venue }}</template>
              </div>
              <div class="tl-t">{{ p.title }}</div>
              <p v-if="p.center" class="tl-c">{{ p.center }}</p>
              <PhotoStrip :pids="p.photos" :size="86" />
              <div class="tl-a">
                <button class="btn ghost sm" @click="openNote(p.id)">讲解笔记</button>
                <button v-if="p.coord" class="btn ghost sm" @click="gotoMap(p.coord, { pointId: p.id })">地图定位</button>
                <button class="btn ghost sm" @click="gotoGraph(p.id)">图谱</button>
              </div>
            </div>
          </li>
        </ol>
      </section>

      <!-- 沿途观测 -->
      <section v-if="d.roadside.length" class="card dsec">
        <h3 class="dsec-t">沿途观测 <span class="mono cnt">{{ d.roadside.length }}</span></h3>
        <div v-for="(r, i) in (showRoadside ? d.roadside : d.roadside.slice(0, 4))" :key="i" class="rs">
          <div class="rs-h mono">{{ r.time }}<template v-if="r.alt && r.alt !== '—'"> · {{ r.alt }} m</template></div>
          <div class="rs-s">{{ r.spot }}</div>
          <div class="rs-n">{{ r.note }}</div>
        </div>
        <button v-if="d.roadside.length > 4" class="fold" @click="showRoadside = !showRoadside">
          {{ showRoadside ? '收起' : `展开其余 ${d.roadside.length - 4} 条` }} {{ showRoadside ? '▴' : '▾' }}
        </button>
      </section>

      <!-- 沿途掠影 -->
      <section v-if="d.roadPhotos.length" class="dsec">
        <h3 class="dsec-t out">沿途掠影</h3>
        <PhotoStrip :pids="d.roadPhotos" :size="104" />
      </section>

      <!-- 当日要点 -->
      <section v-if="d.keypoints" class="card dsec">
        <h3 class="dsec-t">当日要点</h3>
        <NoteBody :md="d.keypoints" />
      </section>

      <div class="dfoot">
        <button class="btn" @click="openNote(d.dayNoteId)">当日完整笔记</button>
        <button class="btn ghost" @click="gotoGraph(d.dayNoteId)">在图谱中查看</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dwrap { display: flex; flex-direction: column; background: var(--paper); }
.dhead { flex: none; padding: calc(12px + env(safe-area-inset-top)) 16px 0;
  border-bottom: 1px solid var(--line-soft); background: var(--paper); }
.dtabs { display: flex; gap: 4px; margin-top: 8px; overflow-x: auto; scrollbar-width: none; }
.dtabs::-webkit-scrollbar { display: none; }
.dtab { display: flex; align-items: baseline; gap: 6px; padding: 8px 14px 10px;
  border-bottom: 2.5px solid transparent; color: var(--ink-3); }
.dtab.on { color: var(--ink); border-bottom-color: var(--dc, var(--pine)); }
.dtab-n { font-family: var(--serif); font-size: 21px; font-weight: 600; letter-spacing: .02em; }
.dtab-w { font-size: 12px; }
.dscroll { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 16px 16px 26px; display: flex; flex-direction: column; gap: 14px; }
.dhero { padding: 4px 2px 0; }
.dhero-top { display: flex; align-items: center; gap: 14px; }
.dhero-num { font-family: var(--serif); font-size: 54px; font-weight: 700; line-height: 1;
  letter-spacing: .01em; }
.dhero-meta { font-size: 12.5px; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; }
.dhero-stats { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--ink-3); font-size: 12px; }
.droute { font-family: var(--serif); font-size: 15px; line-height: 1.8; margin-top: 12px;
  color: var(--ink); }
.dsum { font-size: 13.5px; line-height: 1.75; color: var(--ink-2); margin: 10px 0 0;
  padding: 10px 14px; background: color-mix(in srgb, var(--pine) 6%, var(--card));
  border-left: 3px solid var(--pine); border-radius: 10px; }
.dsec-t { font-family: var(--serif); font-size: 16px; margin: 0 0 8px; }
.dsec-t.out { padding-left: 2px; }
.dsec-t .cnt { font-size: 12px; color: var(--ink-3); font-weight: 400; }
.dsec-sub { font-size: 12.5px; color: var(--ink-3); margin: 0 0 6px; line-height: 1.6; }
.fold { display: block; width: 100%; text-align: center; font-size: 13px; color: var(--pine);
  padding: 8px 0 2px; }
.fold.ghostlink { text-align: left; padding-top: 10px; }
.tblw { overflow-x: auto; margin-top: 8px; border: 1px solid var(--line-soft); border-radius: 10px; }
.tblw table { border-collapse: collapse; font-size: 12px; width: 100%; }
.tblw th, .tblw td { padding: 6px 8px; border-bottom: 1px solid var(--line-soft);
  text-align: right; white-space: nowrap; }
.tblw th:first-child, .tblw td:first-child { text-align: left; }
.tblw th { color: var(--ink-3); font-weight: 500; background: var(--card-2); }
.tblw tr:last-child td { border-bottom: none; }
.tloc { max-width: 30vw; overflow: hidden; text-overflow: ellipsis; }
.tl { list-style: none; margin: 0; padding: 0 0 0 16px; position: relative;
  display: flex; flex-direction: column; gap: 12px; }
.tl::before { content: ''; position: absolute; left: 15px; top: 10px; bottom: 12px;
  width: 2px; background: color-mix(in srgb, var(--dc) 32%, transparent); border-radius: 1px; }
.tl-i { position: relative; padding-left: 26px; }
.tl-badge { position: absolute; left: -14px; top: 12px; width: 28px; height: 28px;
  border-radius: 50%; background: var(--dc); color: #fff; font-weight: 700; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  border: 2.5px solid var(--paper); z-index: 1; }
.tl-card { padding: 12px 14px; }
.tl-time { font-size: 11.5px; color: var(--ink-3); }
.tl-t { font-family: var(--serif); font-size: 15.5px; line-height: 1.45; margin: 3px 0 4px;
  text-wrap: balance; }
.tl-c { font-size: 13px; line-height: 1.7; color: var(--ink-2); margin: 0 0 8px; }
.tl-a { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.btn.sm { padding: 6px 12px; font-size: 12.5px; border-radius: 8px; }
.rs { padding: 9px 0; border-bottom: 1px solid var(--line-soft); }
.rs:last-of-type { border-bottom: none; }
.rs-h { font-size: 11.5px; color: var(--ink-3); }
.rs-s { font-size: 14px; font-weight: 600; margin: 1px 0; }
.rs-n { font-size: 13px; color: var(--ink-2); line-height: 1.65; }
.dfoot { display: flex; gap: 10px; justify-content: center; padding: 6px 0 10px; }
</style>
