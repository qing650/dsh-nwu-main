// 西北大学教务问答 · 检索评测：A(纯词法) / B(+知识图谱扩展) 两组对照
// 测试集由教务知识库自动构建：条目原文检索 + 关联条目检索
// 运行：node tools/eval_qa.mjs
// 回归：EVAL_ENGINE=dsh node tools/eval_qa.mjs  → 用 dsh-georag 插件引擎做一致性对照
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'

const { createEngine } = await import(
  process.env.EVAL_ENGINE === 'dsh'
    ? '../dsh-georag/src/engine.js'
    : '../web/src/lib/qa/engine.js'
)

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = p => JSON.parse(readFileSync(path.join(here, '../data', p), 'utf8'))

const days = DATA('days_data.json')
const mapLayers = DATA('map_data.json').layers

// 优先使用 SQLite 图数据库中的节点，数据库缺失时回退到 JSON 种子。
function loadNodes() {
  const dbPath = path.join(here, '../data/nwu.sqlite')
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare(`
        SELECT id, title, kind, md, relations, coordinate, date, time, altitude
        FROM graph_nodes
        ORDER BY source = 'base' DESC, COALESCE(revision, 0) ASC
      `).all()
      return rows.map(row => {
        let out = []
        try { out = JSON.parse(String(row.relations || '[]')) } catch { out = [] }
        const node = { id: row.id, t: row.title, k: row.kind, out, md: row.md || '' }
        if (row.coordinate) {
          try { node.c = JSON.parse(row.coordinate) } catch { /* ignore */ }
        }
        if (row.date) node.date = row.date
        if (row.time) node.time = row.time
        if (row.altitude != null) node.alt = row.altitude
        return node
      })
    } finally {
      db.close()
    }
  }
  return DATA('graph_data.json').nodes
}

const nodes = loadNodes()
const eng = createEngine({ nodes, days, mapLayers })
const byId = new Map(nodes.map(n => [n.id, n]))
const byTitle = new Map()
for (const n of nodes) {
  byId.set(n.id, n)
  byTitle.set(n.t, n)
}

// ---------------- 测试集构建 ----------------
const testset = []

// F1 条目检索："标题 + 怎么办/是什么"应命中该教务条目
for (const n of nodes) {
  if (n.k === '索引') continue
  const verb = n.t.includes('？') ? '的具体答复是什么' : '有哪些要点'
  testset.push({ family: '条目检索', q: `${n.t}${verb}？`, gold: [n.id] })
}

// F2 关联检索：“某条目与哪些条目有关？”应命中它的直接关联条目；
// 反向用目标条目标题生成问句，同时校验出链完整、双向可达。
for (const n of nodes) {
  const targets = (n.out || []).map(t => byTitle.get(t)).filter(Boolean).slice(0, 2)
  for (const tgt of targets) {
    testset.push({ family: '关联检索', q: `${n.t}与哪些教务条目有关？`, gold: [tgt.id], graphQ: true })
  }
}

// F3 场景问句：配置的常见问题，应命中标题或正文中包含关键词的条目。
const KEYWORDS = new Map([
  ['新生选课', ['选课']],
  ['成绩更正', ['成绩更正', '成绩']],
  ['缓考', ['缓考']],
  ['重修', ['重修', '补修']],
  ['转专业', ['专业准入']],
  ['体育课退选', ['体育课', '退选']],
  ['休学复学', ['休学', '复学']],
])
for (const [label, keys] of KEYWORDS) {
  const q = label.includes('？') ? label : `${label}怎么办？`
  const gold = nodes.filter(n => keys.some(k => (n.t || '').includes(k))).map(n => n.id)
  if (gold.length) testset.push({ family: '场景问句', q, gold })
}

// ---------------- 两组配置 ----------------
const CONFIGS = {
  'A 纯词法': { lex: 1, graph: 0, spatial: 0 },
  'B +图谱': { lex: 1, graph: 0.5, spatial: 0 },
}

function evalConfig(weights) {
  const per = {}
  for (const t of testset) {
    const res = eng.search(t.q, { weights, topK: 10, perNote: 1 })
    const ranked = res.hits.map(h => h.chunk.nid)
    const goldSet = new Set(t.gold)
    const rank = ranked.findIndex(nid => goldSet.has(nid))
    const fam = per[t.family] || (per[t.family] = { n: 0, h1: 0, h3: 0, h5: 0, rr: 0 })
    fam.n++
    if (rank === 0) fam.h1++
    if (rank > -1 && rank < 3) fam.h3++
    if (rank > -1 && rank < 5) fam.h5++
    if (rank > -1) fam.rr += 1 / (rank + 1)
  }
  const total = { n: 0, h1: 0, h3: 0, h5: 0, rr: 0 }
  for (const f of Object.values(per)) for (const k of ['n', 'h1', 'h3', 'h5', 'rr']) total[k] += f[k]
  per['总计'] = total
  return per
}

const pct = (a, b) => (100 * a / b).toFixed(1)
const results = {}
for (const [name, w] of Object.entries(CONFIGS)) results[name] = evalConfig(w)

// ---------------- 输出 ----------------
const fams = ['条目检索', '关联检索', '场景问句', '总计']
const counts = Object.fromEntries(fams.map(f => [f, results['A 纯词法'][f]?.n || 0]))
console.log(`测试集：共 ${testset.length} 题（条目检索 ${counts['条目检索']} · 关联检索 ${counts['关联检索']} · 场景问句 ${counts['场景问句']}）\n`)

let md = `# 西北大学教务问答 检索评测报告\n\n`
md += `- 语料：知识图谱 ${nodes.length} 节点 → ${eng.stats.chunks} 个知识块\n`
md += `- 测试集：**${testset.length} 题**，由教务知识库自动构建 — 条目检索（标题→命中对应条目）、关联检索（关联条目间可达）、场景问句（选课/成绩/缓考/重修/转专业等关键词）\n`
md += `- 指标：Hit@k = 前 k 条结果（按条目去重）命中任一正解的比例；MRR = 平均倒数排名\n`
md += `- 对照：A 纯词法(BM25 中文二元组)；B = A + 知识图谱双链扩展\n\n`

for (const fam of fams) {
  md += `## ${fam}（${counts[fam]} 题）\n\n| 配置 | Hit@1 | Hit@3 | Hit@5 | MRR |\n|---|---|---|---|---|\n`
  console.log(`【${fam}】 (${counts[fam]} 题)`)
  for (const [name, per] of Object.entries(results)) {
    const f = per[fam]
    if (!f) continue
    const row = `${pct(f.h1, f.n)}% | ${pct(f.h3, f.n)}% | ${pct(f.h5, f.n)}% | ${(f.rr / f.n).toFixed(3)}`
    md += `| ${name} | ${row.replaceAll(' | ', ' | ')} |\n`
    console.log(`  ${name.padEnd(10)} Hit@1 ${pct(f.h1, f.n)}%  Hit@3 ${pct(f.h3, f.n)}%  Hit@5 ${pct(f.h5, f.n)}%  MRR ${(f.rr / f.n).toFixed(3)}`)
  }
  md += `\n`
  console.log()
}

// 失例样本（B 配置 Hit@5 未命中）
const misses = []
for (const t of testset) {
  const res = eng.search(t.q, { weights: CONFIGS['B +图谱'], topK: 5, perNote: 1 })
  if (!res.hits.some(h => t.gold.includes(h.chunk.nid))) misses.push(t)
}
md += `## 失例（B 配置 Hit@5 未命中，共 ${misses.length} 题）\n\n`
for (const m of misses.slice(0, 15)) md += `- [${m.family}] ${m.q.slice(0, 60)} → 期望 ${m.gold[0]}${m.gold.length > 1 ? ` 等${m.gold.length}项` : ''}\n`
console.log(`B 配置未命中 ${misses.length}/${testset.length} 题`)

const outDir = path.join(here, '../评测')
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'eval_report.md'), md, 'utf8')
writeFileSync(path.join(outDir, 'eval_results.json'), JSON.stringify({ testsetSize: testset.length, counts, results, misses: misses.map(m => ({ family: m.family, q: m.q, gold: m.gold })) }, null, 2), 'utf8')
console.log('\n报告已写入 评测/eval_report.md')
