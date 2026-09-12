// Graph RAG 多路检索消融评测：词法 / 图谱 / 向量分别单独使用，
// 再做两两组合和全量融合，输出到独立的 评测/eval_rag_vector_* 文件。
// 运行：node tools/eval_rag_methods.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { createEngine } from '../dsh-georag/src/engine.js'
import { createHashEmbedder } from '../dsh-georag/src/embedding.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA = p => JSON.parse(readFileSync(path.join(here, '../data', p), 'utf8'))
const days = DATA('days_data.json')
const mapLayers = DATA('map_data.json').layers

const embedder = createHashEmbedder({ dim: 768 })

function loadGraph() {
  const dbPath = path.join(here, '../data/nwu.sqlite')
  if (!existsSync(dbPath)) {
    const nodes = DATA('graph_data.json').nodes
    const embeddings = new Map(nodes.map(n => [n.id, embedder.embed(n.md || n.t || '')]))
    return { nodes, embeddings }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const nodeRows = db.prepare(`
      SELECT id, title, kind, md, relations, coordinate, date, time, altitude
      FROM graph_nodes
      ORDER BY source = 'base' DESC, COALESCE(revision, 0) ASC
    `).all()
    const nodes = nodeRows.map(row => {
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
    const embeddings = new Map()
    const embRows = db.prepare('SELECT node_id, dim, vector FROM node_embeddings').all()
    for (const row of embRows) {
      const buf = Buffer.from(row.vector)
      const dim = Number(row.dim || Math.floor(buf.length / 4))
      embeddings.set(row.node_id, new Float32Array(buf.buffer, buf.byteOffset, dim))
    }
    if (embeddings.size !== nodes.length) {
      for (const node of nodes) {
        if (!embeddings.has(node.id)) embeddings.set(node.id, embedder.embed(node.md || node.t || ''))
      }
    }
    return { nodes, embeddings }
  } finally {
    db.close()
  }
}

const { nodes, embeddings } = loadGraph()
const byId = new Map(nodes.map(n => [n.id, n]))
const byTitle = new Map()
for (const n of nodes) {
  byId.set(n.id, n)
  byTitle.set(n.t, n)
}
const engine = createEngine({
  nodes,
  days,
  mapLayers,
  embeddings,
  embedText: embedder.embed,
})

// ---------------- 测试集（与 tools/eval_qa.mjs 相同构造） ----------------
const testset = []

for (const n of nodes) {
  if (n.k === '索引') continue
  const verb = n.t.includes('？') ? '的具体答复是什么' : '有哪些要点'
  testset.push({ family: '条目检索', q: `${n.t}${verb}？`, gold: [n.id] })
}

for (const n of nodes) {
  const targets = (n.out || []).map(t => byTitle.get(t)).filter(Boolean).slice(0, 2)
  for (const tgt of targets) {
    testset.push({ family: '关联检索', q: `${n.t}与哪些教务条目有关？`, gold: [tgt.id], graphQ: true })
  }
}

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

// ---------------- 检索配置：单独 / 两两组合 / 全量融合 ----------------
const CONFIGS = {
  'A_纯词法': { lex: 1, graph: 0, vector: 0, spatial: 0 },
  'B_纯图谱': { lex: 0, graph: 1, vector: 0, spatial: 0 },
  'C_纯向量': { lex: 0, graph: 0, vector: 1, spatial: 0 },
  'D_词法+图谱': { lex: 1, graph: 0.5, vector: 0, spatial: 0 },
  'E_词法+向量': { lex: 1, graph: 0, vector: 0.6, spatial: 0 },
  'F_图谱+向量': { lex: 0, graph: 0.6, vector: 1, spatial: 0 },
  'G_词法+图谱+向量': { lex: 1, graph: 0.5, vector: 0.4, spatial: 0 },
}

function evalConfig(weights) {
  const per = {}
  for (const t of testset) {
    const res = engine.search(t.q, { weights, topK: 10, perNote: 1 })
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

const fams = ['条目检索', '关联检索', '场景问句', '总计']
const counts = Object.fromEntries(fams.map(f => [f, results['A_纯词法'][f]?.n || 0]))

console.log(`Graph RAG 多路检索测试集：${testset.length} 题\n`)
let md = '# Graph RAG 多路检索消融评测\n\n'
md += `- 语料：SQLite graph_nodes ${nodes.length} 节点 / 向量维度 ${embedder.dim}\n`
md += `- 嵌入方式：${embedder.name}（本地定长哈希向量，存储于 node_embeddings 表）\n`
md += `- 测试集：${testset.length} 题（条目检索 ${counts['条目检索']} · 关联检索 ${counts['关联检索']} · 场景问句 ${counts['场景问句']}）\n`
md += `- 评测方式：每个配置单独检索同一测试集；Hit@k = 前 k 条命中任一正解；MRR = 平均倒数排名\n\n`

for (const fam of fams) {
  md += `## ${fam}（${counts[fam]} 题）\n\n| 配置 | Hit@1 | Hit@3 | Hit@5 | MRR |\n|---|---|---|---|---|\n`
  console.log(`【${fam}】(${counts[fam]} 题)`)
  for (const [name, per] of Object.entries(results)) {
    const f = per[fam]
    if (!f) continue
    const row = `${pct(f.h1, f.n)}% | ${pct(f.h3, f.n)}% | ${pct(f.h5, f.n)}% | ${(f.rr / f.n).toFixed(3)}`
    md += `| ${name} | ${row.replaceAll(' | ', ' | ')} |\n`
    console.log(`  ${name.padEnd(14)} Hit@1 ${pct(f.h1, f.n).padStart(6)}% Hit@3 ${pct(f.h3, f.n).padStart(6)}% Hit@5 ${pct(f.h5, f.n).padStart(6)}% MRR ${(f.rr / f.n).toFixed(3)}`)
  }
  md += '\n'
  console.log()
}

const misses = []
const best = 'G_词法+图谱+向量'
for (const t of testset) {
  const res = engine.search(t.q, { weights: CONFIGS[best], topK: 5, perNote: 1 })
  if (!res.hits.some(h => t.gold.includes(h.chunk.nid))) misses.push(t)
}
md += `## ${best} 的失例（Hit@5 未命中，共 ${misses.length} 题）\n\n`
for (const m of misses.slice(0, 15)) md += `- [${m.family}] ${m.q.slice(0, 60)}\n`

const outDir = path.join(here, '../评测')
mkdirSync(outDir, { recursive: true })
const reportPath = path.join(outDir, 'eval_rag_vector_report.md')
const jsonPath = path.join(outDir, 'eval_rag_vector_results.json')
const csvPath = path.join(outDir, 'eval_rag_vector_results.csv')

writeFileSync(reportPath, md, 'utf8')
writeFileSync(jsonPath, JSON.stringify({
  embedding: { name: embedder.name, dim: embedder.dim, storage: 'data/nwu.sqlite → node_embeddings' },
  testsetSize: testset.length,
  counts,
  configs: CONFIGS,
  results,
  misses: misses.map(m => ({ family: m.family, q: m.q, gold: m.gold })),
}, null, 2), 'utf8')

const csvRows = []
csvRows.push('family,config,hits,total,hit1,hit3,hit5,mrr')
for (const fam of fams) {
  for (const [name, per] of Object.entries(results)) {
    const f = per[fam]
    if (!f) continue
    csvRows.push(`${fam},${name},${f.h5},${f.n},${pct(f.h1, f.n)},${pct(f.h3, f.n)},${pct(f.h5, f.n)},${(f.rr / f.n).toFixed(4)}`)
  }
}
writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8')

console.log('结果文件：')
console.log('  评测/eval_rag_vector_report.md')
console.log('  评测/eval_rag_vector_results.json')
console.log('  评测/eval_rag_vector_results.csv')
