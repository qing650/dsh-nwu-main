<script setup>
// 西北大学教务问答 · 问答视图（前后端分离）
// 浏览器只负责渲染与交互：把问题 POST 给后端，后端跑 agent 循环（模型自主调用本地工具），
// 通过 SSE 把 检索结果 / 工具轨迹 / 文本增量 / 引用表 逐步推回来。密钥不在浏览器里。
import { ref, reactive, nextTick, computed, onMounted } from 'vue'
import { store, site, openNote, gotoGraph } from '../store.js'
import { chat, health } from '../lib/api.js'
import { kindColor } from '../lib/palette.js'
import { renderMd } from '../lib/md.js'

const input = ref('')
const busy = ref(false)
const items = ref([])
const showSettings = ref(false)
const srv = ref(null)             // /api/health
const listEl = ref(null)
let abort = null

onMounted(async () => {
  try { srv.value = await health() } catch { srv.value = null }
})

const EXAMPLES = site.qa.examples
const online = computed(() => !!srv.value?.llm?.online)

function scrollBottom() {
  nextTick(() => { if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight })
}

function stop() {
  if (abort) { abort.abort(); abort = null }
}

async function ask(preset) {
  const q = (typeof preset === 'string' ? preset : input.value).trim()
  if (!q || busy.value) return
  if (typeof preset !== 'string') input.value = ''
  busy.value = true

  const t0 = performance.now()
  const item = reactive({
    id: Date.now(), q,
    cites: [], loc: null, places: [], anchor: null, spatial: false, ms: 0,
    mode: 'agent', llmText: '', llmErr: '', streaming: true,
    trace: [], traceOpen: false,
  })
  items.value.push(item)
  if (items.value.length > 12) items.value.shift()
  scrollBottom()

  // 只把最终文本作为历史带回去，不带工具流水，省 token
  const history = items.value.slice(0, -1)
    .filter(x => x.llmText && !x.llmErr).slice(-3)
    .map(x => ({ q: x.q, a: x.llmText }))

  abort = new AbortController()
  try {
    const done = await chat({
      question: q,
      history,
      coord: null,
      signal: abort.signal,
      on: {
        retrieval: d => {
          item.ms = Math.round(performance.now() - t0)
          item.cites = d.cites || []
          item.loc = d.loc || null
          item.places = d.places || []
          item.anchor = d.anchor || null
          item.spatial = !!d.spatial
          scrollBottom()
        },
        tool: d => {
          item.trace.push({ name: d.name, arg: d.arg, pending: true, summary: '' })
          scrollBottom()
        },
        tool_result: d => {
          for (let i = item.trace.length - 1; i >= 0; i--) {
            if (item.trace[i].name === d.name && item.trace[i].pending) {
              item.trace[i].pending = false
              item.trace[i].summary = d.summary
              break
            }
          }
        },
        text: d => { item.llmText += d.delta; scrollBottom() },
        // 上一轮的文字是"让我查一下…"这类过程叙述，工具一开跑就丢掉，
        // 只留最后一轮的正文。这样流式打字效果保留，但正文不被叙述污染。
        text_discard: () => { item.llmText = '' },
        refs: rs => {
          if (Array.isArray(rs) && rs.length) {
            item.cites = rs.map(r => ({
              idx: r.idx, nid: r.nid, kind: r.kind, title: r.title,
              coord: r.coord, snips: [],
            }))
          }
        },
        error: d => { item.llmErr = d.message },
      },
    })
    item.mode = done.mode || 'offline'
  } catch (e) {
    item.llmErr = e?.name === 'AbortError' ? '已取消' : (e?.message || String(e))
    item.mode = 'offline'
  }
  item.streaming = false
  abort = null
  busy.value = false
  scrollBottom()
}

const llmHtml = it => renderMd(it.llmText, { dropH1: false })

</script>

<template>
  <div class="ask">
    <div class="ask-head">
      <div class="ask-title">
        <span class="ask-seal"></span>
        <span class="ask-t">{{ site.agentName }}</span>
        <span class="ask-sub">{{ site.agentTagline }}</span>
      </div>
      <button class="ask-gear" aria-label="服务状态" @click="showSettings = true">
        <span class="ask-dot" :class="online ? 'on' : 'off'"></span>
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/>
          <path d="M12 3.2v2.4M12 18.4v2.4M3.2 12h2.4M18.4 12h2.4M5.9 5.9l1.7 1.7M16.4 16.4l1.7 1.7M18.1 5.9l-1.7 1.7M7.6 16.4l-1.7 1.7"
                stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div ref="listEl" class="ask-list">
      <div v-if="!items.length" class="ask-empty">
        <p class="ask-hello">{{ site.hello }}</p>
        <div class="ask-ex">
          <button v-for="q in EXAMPLES" :key="q" class="chip" @click="ask(q)">{{ q }}</button>
        </div>
        <p class="ask-note">
          回答依据 {{ site.stats.nodes }} 条已发布教务知识条目（官方政策、办事指南、常见问答）。
          <template v-if="online">模型自主调用服务端工具多轮查证后作答，每条论断都标注来源。</template>
          <template v-else>服务端未配置模型 Key，当前只提供检索结果。</template>
        </p>
      </div>

      <div v-for="it in items" :key="it.id" class="qa">
        <div class="qa-q">{{ it.q }}</div>

        <div class="qa-a card">
          <!-- 查证轨迹 -->
          <div v-if="it.trace.length" class="qa-trace">
            <button class="qa-trace-h" @click="it.traceOpen = !it.traceOpen">
              <span class="qa-trace-i">⚒</span>
              查证 {{ it.trace.length }} 步
              <span class="qa-trace-x">{{ it.traceOpen ? '收起 ▴' : '展开 ▾' }}</span>
            </button>
            <ol v-if="it.traceOpen" class="qa-trace-b">
              <li v-for="(s, i) in it.trace" :key="i" class="qa-trace-l">
                <code class="qa-trace-n">{{ s.name }}</code>
                <span v-if="s.arg" class="qa-trace-a">{{ s.arg }}</span>
                <span class="qa-trace-r">{{ s.pending ? '查询中…' : s.summary }}</span>
              </li>
            </ol>
          </div>

          <div v-if="it.llmText" class="note" v-html="llmHtml(it)"></div>
          <div v-if="it.streaming" class="qa-typing"><span></span><span></span><span></span></div>
          <div v-if="it.llmErr" class="qa-err">{{ it.llmErr }}——以下为检索结果。</div>

          <div v-if="!it.llmText && !it.streaming" class="qa-off">
            <p v-if="it.cites.length" class="qa-off-lead">与你的问题最相关的教务知识条目：</p>
            <p v-else class="qa-off-lead">教务知识库中未检索到相关内容。换个问法，或点选示例试试。</p>
          </div>

          <div v-if="it.cites.length" class="qa-cites">
            <div v-for="c in it.cites" :key="c.idx" class="qa-cite">
              <div class="qa-cite-h" @click="openNote(c.nid)">
                <span class="qa-cite-n mono">[{{ c.idx }}]</span>
                <span class="k-dot" :style="{ background: kindColor(c.kind, store.isDark) }"></span>
                <span class="qa-cite-t">{{ c.title }}</span>
                <span v-if="c.sec" class="qa-cite-s">· {{ c.sec }}</span>
                <span v-if="c.dist != null" class="qa-cite-d mono">{{ fmtDist(c.dist) }}</span>
              </div>
              <p v-if="!it.llmText && c.snips && c.snips.length" class="qa-cite-snip">{{ c.snips[0] }}</p>
              <div class="qa-cite-act">
                <button class="qa-mini" @click="openNote(c.nid)">打开条目</button>
                <button class="qa-mini" @click="gotoGraph(c.nid)">图谱</button>
              </div>
            </div>
          </div>

          <div class="qa-meta mono">
            <span>{{ it.mode === 'agent' ? (srv?.llm?.model || 'agent') : '离线检索' }}</span>
            <span v-if="it.trace.length">{{ it.trace.length }} 次工具调用</span>
            <span v-if="it.ms">检索 {{ it.ms }} ms</span>
          </div>
        </div>
      </div>
    </div>

    <div class="ask-composer">
      <div class="ask-tools">
        <button v-if="busy" class="chip" @click="stop">■ 停止</button>
      </div>
      <div class="ask-bar">
        <input v-model="input" class="ask-input" type="text" enterkeyhint="send"
               :placeholder="site.inputPlaceholder"
               @keydown.enter="ask()" />
        <button class="ask-send" :disabled="busy || !input.trim()" aria-label="发送" @click="ask()">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M4 12 20 4l-4.5 8L20 20 4 12Zm0 0h9" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 服务状态 -->
    <Transition name="fade">
      <div v-if="showSettings" class="sheet-mask" style="z-index:70" @click="showSettings = false"></div>
    </Transition>
    <Transition name="sheet">
      <div v-if="showSettings" class="sheet" style="z-index:71" role="dialog" aria-modal="true">
        <div class="sheet-grip"></div>
        <div class="sheet-body">
          <h2 class="ask-set-t">{{ site.agentName }} · 服务状态</h2>
          <dl class="feat">
            <div class="feat-row"><dt>站点</dt><dd>{{ srv?.site || site.name }}</dd></div>
            <div class="feat-row"><dt>模型</dt>
              <dd>{{ online ? `${srv.llm.label} / ${srv.llm.model}` : '未配置（仅检索可用）' }}</dd></div>
            <div class="feat-row" v-if="online"><dt>工具轮次</dt><dd>上限 {{ srv.llm.maxIters }} 轮</dd></div>
            <div class="feat-row"><dt>语料</dt>
              <dd>{{ site.stats.nodes }} 条教务知识条目</dd></div>
          </dl>
          <p class="ask-set-note">
            检索、读条目全文、走知识图谱等工具全部在服务端本地执行，不出网。
            API Key 只保存在服务端环境变量（<code>server/.env</code>），浏览器无法读取，
            换 Key 或换模型改服务端配置后重启即可，前端不用重新发布。
          </p>
          <div class="sh-actions">
            <button class="btn" @click="showSettings = false">关闭</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style>
.ask { display: flex; flex-direction: column; background: var(--paper); }
.ask-head { flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: calc(10px + env(safe-area-inset-top)) 14px 8px; }
.ask-title { display: flex; align-items: baseline; gap: 8px; }
.ask-seal { width: 11px; height: 11px; background: var(--seal); border-radius: 2.5px; align-self: center; }
.ask-t { font-family: var(--serif); font-size: 19px; letter-spacing: .14em; }
.ask-sub { font-size: 11px; color: var(--ink-3); letter-spacing: .05em; }
.ask-gear { color: var(--ink-2); padding: 6px; display: flex; align-items: center; gap: 5px; }
.ask-dot { width: 7px; height: 7px; border-radius: 50%; }
.ask-dot.on { background: #1baf7a; }
.ask-dot.off { background: var(--ink-3); }

.ask-list { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 4px 14px 10px; }
.ask-empty { padding-top: 8vh; text-align: center; }
.ask-hello { font-family: var(--serif); font-size: 16.5px; line-height: 2; color: var(--ink-2);
  white-space: pre-line; }
.ask-ex { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 20px 0 14px; }
.ask-note { font-size: 12px; color: var(--ink-3); line-height: 1.8; max-width: 340px; margin: 0 auto; }

.qa { margin: 14px 0; }
.qa-q { margin-left: auto; width: fit-content; max-width: 82%;
  background: var(--pine); color: var(--pine-ink);
  padding: 8px 14px; border-radius: 16px 16px 4px 16px; font-size: 15px; line-height: 1.6; }
.qa-a { margin-top: 10px; padding: 13px 14px; }

.qa-loc { border: 1px solid var(--line-soft); background: var(--card-2);
  border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; }
.qa-loc-t { font-weight: 600; font-size: 13.5px; margin-bottom: 6px; }
.qa-loc-row { display: flex; gap: 8px; font-size: 13.5px; padding: 2px 0; }
.qa-loc-k { flex: none; width: 34px; color: var(--ink-3); font-size: 12.5px; padding-top: 1px; }
.qa-loc-v { line-height: 1.55; }
.qa-loc-near { font-size: 12.5px; color: var(--ink-2); margin-top: 6px; line-height: 1.8; }
.qa-loc-near .wl { margin-right: 10px; }

.qa-trace { border: 1px dashed var(--line); border-radius: 12px; margin-bottom: 10px;
  background: color-mix(in srgb, var(--pine) 4%, transparent); }
.qa-trace-h { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 8px 11px; font-size: 12.5px; color: var(--ink-2); }
.qa-trace-i { color: var(--pine); font-size: 13px; }
.qa-trace-x { margin-left: auto; color: var(--ink-3); font-size: 11.5px; }
.qa-trace-b { list-style: none; margin: 0; padding: 0 11px 9px; display: flex;
  flex-direction: column; gap: 6px; }
.qa-trace-l { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 12px; line-height: 1.5; }
.qa-trace-n { font-family: var(--mono); font-size: 11.5px; color: var(--pine);
  background: var(--card-2); padding: 1px 6px; border-radius: 5px; }
.qa-trace-a { font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qa-trace-r { color: var(--ink-2); flex: 1; min-width: 8em; }

.qa-typing { display: flex; gap: 5px; padding: 8px 2px; }
.qa-typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3);
  animation: qa-b 1.2s ease infinite; }
.qa-typing span:nth-child(2) { animation-delay: .18s; }
.qa-typing span:nth-child(3) { animation-delay: .36s; }
@keyframes qa-b { 0%, 60%, 100% { opacity: .25; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .qa-typing span { animation: none; } }

.qa-err { font-size: 12.5px; color: var(--seal); margin: 6px 0; }
.qa-off-lead { font-size: 14px; color: var(--ink-2); margin: 2px 0 8px; }

.qa-cites { display: flex; flex-direction: column; gap: 8px; }
.qa-cite { border: 1px solid var(--line-soft); border-radius: 12px; padding: 9px 11px; }
.qa-cite-h { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; cursor: pointer; }
.qa-cite-n { color: var(--pine); font-size: 12.5px; font-weight: 700; }
.qa-cite-t { font-size: 13.5px; font-weight: 600; line-height: 1.45; }
.qa-cite-s { font-size: 12.5px; color: var(--ink-3); }
.qa-cite-d { margin-left: auto; font-size: 11.5px; color: var(--ink-3); }
.qa-cite-snip { font-size: 13px; color: var(--ink-2); line-height: 1.7; margin: 6px 0 0; }
.qa-cite-act { display: flex; gap: 8px; margin-top: 7px; }
.qa-mini { font-size: 12px; color: var(--pine); padding: 3px 10px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--pine) 40%, transparent); }

.qa-meta { display: flex; gap: 14px; margin-top: 10px; font-size: 11px; color: var(--ink-3);
  flex-wrap: wrap; }

.ask-composer { flex: none; padding: 6px 12px calc(10px + env(safe-area-inset-bottom) * 0);
  border-top: 1px solid var(--line-soft); background: var(--paper); }
.ask-tools { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding: 2px 0 8px; }
.ask-tools::-webkit-scrollbar { display: none; }
.ask-bar { display: flex; gap: 8px; align-items: center; }
.ask-input { flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; padding: 11px 14px; font-size: 15px; }
.ask-input::placeholder { color: var(--ink-3); }
.ask-send { flex: none; width: 44px; height: 44px; border-radius: 14px;
  background: var(--pine); color: var(--pine-ink);
  display: flex; align-items: center; justify-content: center; }
.ask-send:disabled { opacity: .4; }

.ask-set-t { font-family: var(--serif); font-size: 18px; margin: 4px 0 10px; }
.ask-set-note { font-size: 12px; color: var(--ink-3); margin-top: 12px; line-height: 1.75; }
.ask-set-note code { font-family: var(--mono); font-size: 11.5px; background: var(--card-2);
  padding: 1px 5px; border-radius: 4px; }
</style>
