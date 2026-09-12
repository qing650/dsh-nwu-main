<script setup>
import { computed, ref } from 'vue'
import { store } from '../store.js'
import { photoById } from '../lib/md.js'

const lb = computed(() => store.lightbox)
const cur = computed(() => lb.value ? photoById(lb.value.pids[lb.value.idx]) : null)

function close() { store.lightbox = null }
function step(d) {
  const l = lb.value
  if (!l) return
  l.idx = (l.idx + d + l.pids.length) % l.pids.length
}
let x0 = null
function ts(e) { x0 = e.touches[0].clientX }
function te(e) {
  if (x0 == null) return
  const dx = e.changedTouches[0].clientX - x0
  if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1)
  x0 = null
}
</script>

<template>
  <Transition name="fade">
    <div v-if="lb && cur" class="lb" @click.self="close"
         @touchstart.passive="ts" @touchend.passive="te">
      <button class="lb-x" aria-label="关闭" @click="close">✕</button>
      <div class="lb-n mono">{{ lb.idx + 1 }} / {{ lb.pids.length }}</div>
      <img :src="cur.u" :alt="cur.c || ''" />
      <div class="lb-cap">
        <span v-if="cur.t" class="mono lb-t">{{ cur.t }}</span>
        <span>{{ cur.c }}</span>
      </div>
      <button v-if="lb.pids.length > 1" class="lb-a l" aria-label="上一张" @click="step(-1)">‹</button>
      <button v-if="lb.pids.length > 1" class="lb-a r" aria-label="下一张" @click="step(1)">›</button>
    </div>
  </Transition>
</template>

<style scoped>
.lb { position: fixed; inset: 0; z-index: 90; background: rgba(8, 12, 10, .93);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 46px 12px calc(30px + env(safe-area-inset-bottom)); }
.lb img { max-width: 100%; max-height: 72dvh; object-fit: contain; border-radius: 8px; }
.lb-x { position: absolute; top: calc(10px + env(safe-area-inset-top)); right: 14px;
  color: #fff; font-size: 20px; padding: 8px; }
.lb-n { position: absolute; top: calc(16px + env(safe-area-inset-top)); left: 16px;
  color: rgba(255,255,255,.7); font-size: 13px; }
.lb-cap { color: rgba(255,255,255,.88); font-size: 13px; line-height: 1.6;
  margin-top: 14px; max-width: 560px; text-align: center; }
.lb-t { color: rgba(255,255,255,.55); margin-right: 8px; }
.lb-a { position: absolute; top: 50%; transform: translateY(-50%);
  color: rgba(255,255,255,.85); font-size: 34px; padding: 14px 10px; line-height: 1; }
.lb-a.l { left: 2px; } .lb-a.r { right: 2px; }
</style>
