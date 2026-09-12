// 端到端答案质量评测：单轮 RAG vs agent 工具循环
// 注意：本脚本面向旧“地理现场”语料（气象/行程/空间）。教务演示数据 days=[] 时测试集为空，
// 若需对教务问答做评测，请改走 dsh-nwu 的检索评测或编写基于官方 FAQ 的问答集。
//
// 检索评测（eval_qa.mjs）只量"有没有把对的笔记排上来"。这个量的是另一回事：
// 最终回答里的数字对不对、引用编号是否有效、该拒答时是否拒答。
//
// 金标准全部从 data/ 程序化生成，不靠人工判断：
//   F1 硬数据   —— 气象实测某测点的气压/气温，答案里必须出现那个数
//   F2 拟合参数 —— 气压—高程回归的 r² 与系数
//   F3 行程事实 —— 某天讲解点个数、某讲解点海拔
//   F4 空间查询 —— 给定经纬度所在的地层时代/土壤（需要压图层，纯文本检索拿不到）
//   F5 越界拒答 —— 实习资料里根本没有的题目，必须明确说未覆盖
//
// 用法：先起 server（配好 Key），再  node tools/eval_agent.mjs [并发数]
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createEngine } from '../web/src/lib/qa/engine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = p => JSON.parse(readFileSync(path.join(here, '../data', p), 'utf8'))
const BASE = process.env.BASE || 'http://localhost:8787'
const CONC = Number(process.argv[2] || 3)

const days = DATA('days_data.json')
const graph = DATA('graph_data.json')
const map = DATA('map_data.json')
const eng = createEngine({ nodes: graph.nodes, days, mapLayers: map.layers })

// ---------------------------------------------------------------- 测试集

const T = []
const num = s => String(s).trim()

// F1 硬数据：每个有气象的天，取海拔最高与最低两个测点
for (const d of days) {
  if (!d.wx?.rows?.length) continue
  const rows = d.wx.rows.filter(r => r.alt && r.P).sort((a, b) => +b.alt - +a.alt)
  for (const r of [rows[0], rows[rows.length - 1]]) {
    if (!r) continue
    T.push({
      family: 'F1 硬数据',
      q: `${d.short} 气象观测中，${r.loc}这个测点实测气压是多少 hPa？`,
      gold: [num(r.P)],
      why: `${d.date} ${r.loc} P=${r.P}`,
    })
  }
}

// F2 拟合参数
for (const d of days) {
  if (!d.wx?.fit) continue
  T.push({
    family: 'F2 拟合参数',
    q: `${d.short} 的气压—高程线性拟合，决定系数 r² 是多少？`,
    gold: [num(d.wx.fit.r2)],
    why: `r²=${d.wx.fit.r2}`,
  })
  T.push({
    family: 'F2 拟合参数',
    q: `${d.short} 气压随高程变化的拟合式里，每上升 1 米气压下降多少 hPa？`,
    gold: [num(d.wx.fit.b)],
    why: `b=${d.wx.fit.b}`,
  })
}

// F3 行程事实
for (const d of days) {
  T.push({
    family: 'F3 行程事实',
    q: `${d.short} 这一天一共有几个讲解点？`,
    gold: [String(d.points.length)],
    why: `${d.points.length} 个`,
  })
}
for (const d of days) {
  // 只取单值海拔；区间值（如 "1150–1361 m"）无法用"金标准字符串出现"来判分
  const p = d.points.find(x => /^\s*\d+(\.\d+)?\s*m?\s*$/.test(String(x.alt || '')))
  if (!p) continue
  T.push({
    family: 'F3 行程事实',
    q: `${d.short} 的讲解点「${p.title}」海拔是多少米？`,
    gold: [num(String(p.alt).replace(/[^\d.]/g, ''))],
    why: `${p.alt} m`,
  })
}

// F4 空间查询：拿几个讲解点坐标，问脚下地层/土壤（只有压图层才知道）
const spatial = []
for (const d of days) {
  for (const p of d.points) {
    if (!p.coord) continue
    const L = eng.locate(p.coord)
    if (L.geology?.e && L.soil?.n) spatial.push({ p, L })
  }
}
for (const s of spatial.slice(0, 4)) {
  T.push({
    family: 'F4 空间查询',
    q: `在经度 ${s.p.coord[0]}、纬度 ${s.p.coord[1]} 这个位置，脚下的地层属于哪个地质时代？土壤是什么类型？`,
    gold: [s.L.geology.e, s.L.soil.n],
    why: `${s.L.geology.e} / ${s.L.soil.n}`,
  })
}

// F5 越界拒答：本区没有的地貌/现象
const OUT = [
  '这次实习考察的喀斯特溶洞发育在哪一层石灰岩里？',
  '实习区内的冰川漂砾和羊背石分布在什么海拔？',
  '这次实习测到的黄土湿陷性系数是多少？',
  '实习区的珊瑚礁台地是什么年代抬升的？',
]
for (const q of OUT) {
  T.push({ family: 'F5 越界拒答', q, gold: null, why: '资料未覆盖，应明确说明' })
}

// ---------------------------------------------------------------- 两种配置

const SYSTEM_SINGLE = `你是西北大学教务知识问答系统内置的评测助手。
只依据下面给出的【检索资料】回答，绝不编造资料之外的内容。
每个论断句末标注依据编号，如 [1] 或 [2][4]。
资料不足以回答时明确说"已发布知识库中未覆盖此问题"。
中文回答，控制在 400 字以内。`

/** A 配置：复刻 agent 化之前的单轮 RAG —— 一次检索、截断、一次模型调用 */
async function askSingle(q) {
  const res = eng.search(q)
  const ctx = res.hits.slice(0, 6).map((h, i) =>
    `[${i + 1}] ${h.chunk.kind}《${h.chunk.title}》${h.chunk.sec ? ' · ' + h.chunk.sec : ''}\n` +
    h.chunk.text.slice(0, 1300)).join('\n\n')
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'deepseek-v4-flash',
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_SINGLE },
        { role: 'user', content: `【检索资料】\n${ctx}\n\n【问题】${q}` },
      ],
    }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  return { text: j.choices?.[0]?.message?.content || '', tools: 0, refs: res.hits.length }
}

/** B 配置：走服务端 agent 循环（SSE） */
async function askAgent(q) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: q }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const rd = r.body.getReader(), dec = new TextDecoder()
  let buf = '', text = '', tools = 0, refs = [], err = null
  for (;;) {
    const { done, value } = await rd.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const bl = buf.split('\n\n'); buf = bl.pop()
    for (const b of bl) {
      let ev = 'msg'; const pay = []
      for (const l of b.split('\n')) {
        if (l.startsWith(':')) continue
        if (l.startsWith('event:')) ev = l.slice(6).trim()
        else if (l.startsWith('data:')) pay.push(l.slice(5).trim())
      }
      if (!pay.length) continue
      let d; try { d = JSON.parse(pay.join('\n')) } catch { continue }
      if (ev === 'text') text += d.delta
      else if (ev === 'text_discard') text = ''
      else if (ev === 'tool') tools++
      else if (ev === 'refs') refs = d
      else if (ev === 'error') err = d.message
    }
  }
  if (err) throw new Error(err)
  return { text, tools, refs: refs.length, refIdx: refs.map(x => x.idx) }
}

// ---------------------------------------------------------------- 判分

// 认定"明确拒答"：既接受直白拒答，也接受"资料里没有 + 说明为什么本区不发育"这类更好的回答
const REFUSE = new RegExp([
  '未覆盖', '没有涉及', '未涉及', '没有记录', '未记录', '没有提及', '未提及', '查不到', '找不到',
  '资料(?:中|里|内)(?:并)?(?:没有|无)', '不在.{0,8}范围', '无法(?:从|根据).{0,10}回答',
  '不发育', '并未(?:找到|发现)', '没有.{0,10}证据', '本区.{0,6}(?:不|没)',
].join('|'))

function score(t, out) {
  const text = out.text || ''
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map(m => +m[1])
  const maxRef = out.refIdx ? Math.max(0, ...out.refIdx) : out.refs
  const badCite = cited.filter(n => n < 1 || n > maxRef)
  const s = {
    cited: cited.length,
    citeValid: cited.length === 0 ? null : badCite.length === 0,
    badCite,
    tools: out.tools,
    chars: text.length,
  }
  if (t.gold === null) {
    s.correct = REFUSE.test(text)          // 越界题：判是否明确拒答
  } else {
    s.correct = t.gold.every(g => text.includes(g))   // 事实题：金标准必须出现
    s.missing = t.gold.filter(g => !text.includes(g))
  }
  return s
}

// ---------------------------------------------------------------- 跑

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const k = i++
      if (k >= items.length) return
      out[k] = await fn(items[k], k)
    }
  }))
  return out
}

const CONFIGS = { 'A 单轮RAG': askSingle, 'B agent循环': askAgent }
const results = {}

console.log(`测试集 ${T.length} 题：` +
  Object.entries(T.reduce((a, t) => (a[t.family] = (a[t.family] || 0) + 1, a), {}))
    .map(([k, v]) => `${k} ${v}`).join(' · '))
console.log(`并发 ${CONC}，模型 ${process.env.LLM_MODEL || 'deepseek-v4-flash'}\n`)

for (const [name, fn] of Object.entries(CONFIGS)) {
  process.stdout.write(`跑 ${name} …`)
  const t0 = Date.now()
  const rows = await pool(T, CONC, async (t) => {
    try {
      const out = await fn(t.q)
      return { t, s: score(t, out), text: out.text }
    } catch (e) {
      return { t, s: { correct: false, error: e.message, tools: 0, cited: 0, citeValid: null }, text: '' }
    }
  })
  results[name] = { rows, ms: Date.now() - t0 }
  console.log(` ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------------------------------------------------------------- 报告

const fams = [...new Set(T.map(t => t.family))]
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—'

let md = '# 端到端答案质量评测：单轮 RAG vs agent 工具循环\n\n'
md += `- 测试集 **${T.length} 题**，金标准由 \`data/\` 程序化生成（气象实测值、拟合参数、行程事实、空间查询结果），越界题人工设计\n`
md += `- 判分：事实题=金标准字符串出现在回答里；越界题=是否明确说明资料未覆盖；引用有效=回答里的 [n] 都在引用表范围内\n`
md += `- A 配置复刻 agent 化之前的单轮 RAG（检索 top-6、每块截 1300 字、一次模型调用）\n`
md += `- 模型 ${process.env.LLM_MODEL || 'deepseek-v4-flash'}\n\n`

md += '## 分族准确率\n\n| 题族 | 题数 | A 单轮RAG | B agent循环 |\n|---|---|---|---|\n'
console.log('\n分族准确率:')
for (const f of fams) {
  const cells = Object.keys(CONFIGS).map(name => {
    const rs = results[name].rows.filter(r => r.t.family === f)
    return pct(rs.filter(r => r.s.correct).length, rs.length)
  })
  const n = T.filter(t => t.family === f).length
  md += `| ${f} | ${n} | ${cells[0]} | ${cells[1]} |\n`
  console.log(`  ${f.padEnd(14)} n=${String(n).padStart(2)}  A ${cells[0].padStart(6)}   B ${cells[1].padStart(6)}`)
}

md += '\n## 总计\n\n| 配置 | 准确率 | 引用有效率 | 平均工具调用 | 平均字数 | 总耗时 |\n|---|---|---|---|---|---|\n'
console.log('\n总计:')
for (const name of Object.keys(CONFIGS)) {
  const { rows, ms } = results[name]
  const acc = pct(rows.filter(r => r.s.correct).length, rows.length)
  const withCite = rows.filter(r => r.s.citeValid !== null)
  const cv = pct(withCite.filter(r => r.s.citeValid).length, withCite.length)
  const tools = (rows.reduce((a, r) => a + (r.s.tools || 0), 0) / rows.length).toFixed(1)
  const chars = Math.round(rows.reduce((a, r) => a + (r.s.chars || 0), 0) / rows.length)
  md += `| ${name} | **${acc}** | ${cv} | ${tools} | ${chars} | ${(ms / 1000).toFixed(0)}s |\n`
  console.log(`  ${name.padEnd(12)} 准确 ${acc.padStart(6)}  引用有效 ${cv.padStart(6)}  ` +
    `工具 ${tools}  字数 ${chars}  ${(ms / 1000).toFixed(0)}s`)
}

md += '\n## B 配置失败样例\n\n'
const miss = results['B agent循环'].rows.filter(r => !r.s.correct)
for (const r of miss.slice(0, 12)) {
  md += `- **[${r.t.family}]** ${r.t.q}\n  - 期望：${r.t.why}\n`
  md += `  - 实得：${r.s.error ? '× ' + r.s.error : (r.text.slice(0, 160).replace(/\n/g, ' ') || '(空)')}\n`
}
console.log(`\nB 配置未通过 ${miss.length}/${T.length} 题`)

const outDir = path.join(here, '../评测')
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'eval_agent.md'), md, 'utf8')
writeFileSync(path.join(outDir, 'eval_agent.json'), JSON.stringify(
  Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    ms: v.ms,
    rows: v.rows.map(r => ({ family: r.t.family, q: r.t.q, why: r.t.why, ...r.s, text: r.text })),
  }])), null, 2), 'utf8')
console.log('报告已写入 评测/eval_agent.md')
