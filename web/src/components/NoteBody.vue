<script setup>
import { computed } from 'vue'
import { renderMd } from '../lib/md.js'
import { resolveNote, openNote, openLightbox } from '../store.js'

const props = defineProps({ md: String })
const html = computed(() => renderMd(props.md, { resolve: resolveNote }))

function onClick(e) {
  const wl = e.target.closest('a.wl')
  if (wl) {
    e.preventDefault()
    openNote(wl.dataset.wl)
    return
  }
  const img = e.target.closest('img[data-pid]')
  if (img) {
    const all = [...e.currentTarget.querySelectorAll('img[data-pid]')].map(i => i.dataset.pid)
    openLightbox(all, all.indexOf(img.dataset.pid))
  }
}
</script>

<template>
  <div class="note" v-html="html" @click="onClick"></div>
</template>
