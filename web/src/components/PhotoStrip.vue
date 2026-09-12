<script setup>
import { computed } from 'vue'
import { photoById } from '../lib/md.js'
import { openLightbox } from '../store.js'

const props = defineProps({ pids: Array, size: { type: Number, default: 96 } })
const items = computed(() => (props.pids || [])
  .map(pid => ({ pid, p: photoById(pid) }))
  .filter(x => x.p))
</script>

<template>
  <div v-if="items.length" class="strip" :style="{ '--h': size + 'px' }">
    <button v-for="(it, i) in items" :key="it.pid" class="ph"
            :aria-label="it.p.c || '照片'"
            @click="openLightbox(items.map(x => x.pid), i)">
      <img :src="it.p.u" :alt="it.p.c || ''" loading="lazy" />
    </button>
  </div>
</template>

<style scoped>
.strip { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding: 2px 0; }
.strip::-webkit-scrollbar { display: none; }
.ph { flex: none; height: var(--h); border-radius: 10px; overflow: hidden;
  border: 1px solid var(--line-soft); }
.ph img { height: 100%; width: auto; max-width: 60vw; object-fit: cover; }
</style>
