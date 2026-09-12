// 知识问答 · 检索增强引擎
// 多路召回：词法(BM25/中文二元组) + 图谱(双链扩展) + 向量(余弦) + 空间(距离衰减)，融合排序。
// 纯 ESM、零浏览器依赖：AskView 与 tools/eval_qa.mjs 共用同一实现。

const LOCATIVE_RE = /这里|这儿|此处|附近|周围|周边|旁边|眼前|脚下|身边|沿线|沿途|最近|我在|离我|走到|站在/
const STOP = new Set(['什么', '怎么', '如何', '为什么', '哪些', '哪里', '是不是', '有没有',
  '一个', '这个', '那个', '可以', '我们', '他们', '的话', '就是', '还是', '以及', '关于'])

// ---------------- 文本 ----------------

/** 去掉 wikilink/markdown 记号，保留可读文本 */
export function stripMd(s) {
  if (!s) return ''
  return s
    .replace(/\{\{photo:[^}]+\}\}/g, '')
    .replace(/\[\[([^\]]+?)\]\]/g, (_, inner) => {
      inner = inner.replace(/\\\|/g, '|')
      const [t, alias] = inner.split('|')
      return (alias || t.split('#')[0]).trim()
    })
    .replace(/^>\s*\[!\w+\][+-]?\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`#]|\|/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
}

/** 中文二元组 + ASCII 词 + 数字 */
export function tokenize(s) {
  const out = []
  if (!s) return out
  const clean = s.toLowerCase()
  // ASCII 词与数字
  for (const m of clean.matchAll(/[a-z][a-z0-9]{1,}|[0-9]+(?:\.[0-9]+)?/g)) out.push(m[0])
  // 连续汉字段 → 二元组（单字段落作一元）
  for (const m of clean.matchAll(/[一-鿿]+/g)) {
    const seg = m[0]
    if (seg.length === 1) { out.push(seg); continue }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2)
      if (!STOP.has(bg)) out.push(bg)
    }
  }
  return out
}

function sentences(text) {
  return text.split(/(?<=[。！？；：])|\n+/).map(t => t.trim()).filter(t => t.length > 4)
}

/** 归一化后求余弦相似度 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  if (!aa || !bb) return 0
  return dot / (Math.sqrt(aa) * Math.sqrt(bb))
}

// ---------------- 几何 ----------------

const R = 6371000
const rad = d => d * Math.PI / 180

/** 两点球面距离（米），点为 [lon, lat] */
export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function pointInRing(pt, ring) {
  let inside = false
  const [x, y] = pt
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点在面内（Polygon / MultiPolygon，含内环扣除） */
export function pointInPoly(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : []
  for (const rings of polys) {
    if (!rings.length) continue
    if (pointInRing(pt, rings[0]) && rings.slice(1).every(r => !pointInRing(pt, r))) return true
  }
  return false
}

function distToSeg(p, a, b) {
  // 局部平面近似（经度按纬度缩放），返回米
  const ky = 110540, kx = 111320 * Math.cos(rad(p[1]))
  const px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * ky
  const L2 = bx * bx + by * by
  const t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0
  const dx = px - t * bx, dy = py - t * by
  return Math.sqrt(dx * dx + dy * dy)
}

/** 点到线要素的最小距离（米） */
export function distToLine(pt, geom) {
  const lines = geom.type === 'LineString' ? [geom.coordinates]
    : geom.type === 'MultiLineString' ? geom.coordinates : []
  let best = Infinity
  for (const line of lines)
    for (let i = 0; i < line.length - 1; i++)
      best = Math.min(best, distToSeg(pt, line[i], line[i + 1]))
  return best
}

// ---------------- 引擎 ----------------

export function createEngine({ nodes, days, mapLayers, embeddings, embedText }) {
  // —— 节点索引、双链邻接 ——
  const nodeById = {}
  const titleToId = {}
  for (const n of nodes) {
    nodeById[n.id] = n
    titleToId[n.id] = n.id
    if (n.t && !titleToId[n.t]) titleToId[n.t] = n.id
  }
  const adj = new Map()
  const touch = id => { if (!adj.has(id)) adj.set(id, new Set()); return adj.get(id) }
  for (const n of nodes) {
    for (const tgt of n.out || []) {
      const t = titleToId[String(tgt).split('#')[0].trim()]
      if (!t || t === n.id) continue
      touch(n.id).add(t); touch(t).add(n.id)
    }
  }

  // —— 坐标：讲解点(days) > 节点自带 c > 地点图层 ——
  const coordOf = {}
  const pointMeta = {}
  days.forEach((d, di) => d.points.forEach(p => {
    if (p.coord) coordOf[p.id] = p.coord
    pointMeta[p.id] = { short: d.short, dayIdx: di, n: p.n, venue: p.venue, center: p.center }
  }))
  for (const n of nodes) if (n.c && !coordOf[n.id]) coordOf[n.id] = n.c
  for (const p of mapLayers.places || []) if (!coordOf[p.id]) coordOf[p.id] = [p.x, p.y]

  // —— 向量：节点 id -> Float32Array ——
  const vecOf = embeddings instanceof Map ? embeddings
    : new Map(Object.entries(embeddings || {}))

  // —— 知识分块：每节点按 "## " 切分 ——
  const chunks = []
  for (const n of nodes) {
    if (n.k === '索引' || !n.md) continue
    const md = n.md.replace(/^---[\s\S]*?---\n/, '')
    const parts = md.split(/\n(?=## )/)
    for (const part of parts) {
      const mh = part.match(/^## +(.+)/)
      const sec = mh ? stripMd(mh[1]).replace(/→.*$/, '').trim() : ''
      if (/^(关联|关联概念|新增概念|本日新增的概念)$/.test(sec)) continue   // 纯链接小节交给图谱通道
      const raw = part.trim()
      const text = stripMd(raw.replace(/^# .+$/m, '')).replace(/\n{2,}/g, '\n').trim()
      if (text.length < 30) continue
      const links = new Set()
      for (const lm of raw.matchAll(/\[\[([^\]]+?)\]\]/g)) {
        const t = titleToId[lm[1].replace(/\\\|/g, '|').split('|')[0].split('#')[0].trim()]
        if (t) links.add(t)
      }
      chunks.push({
        ci: chunks.length, nid: n.id, kind: n.k, title: n.t || n.id,
        sec, raw, text, links: [...links],
        coord: coordOf[n.id] || null,
      })
    }
  }

  // —— BM25 ——
  const df = new Map()
  const tf = []            // ci -> Map(term -> count)
  let totalLen = 0
  for (const c of chunks) {
    const terms = tokenize(c.title + ' ' + c.sec + ' ' + c.text)
    const m = new Map()
    for (const t of terms) m.set(t, (m.get(t) || 0) + 1)
    tf.push(m)
    c.len = terms.length
    totalLen += terms.length
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1)
  }
  const avgLen = totalLen / Math.max(1, chunks.length)
  const N = chunks.length
  const K1 = 1.2, B = 0.75

  function bm25(queryTerms) {
    const scores = new Map()
    const qset = [...new Set(queryTerms)]
    for (const q of qset) {
      const n = df.get(q)
      if (!n) continue
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      for (let ci = 0; ci < N; ci++) {
        const f = tf[ci].get(q)
        if (!f) continue
        const s = idf * f * (K1 + 1) / (f + K1 * (1 - B + B * chunks[ci].len / avgLen))
        scores.set(ci, (scores.get(ci) || 0) + s)
      }
    }
    return scores
  }

  // —— 地名词典（名称长的优先匹配） ——
  const gaz = []
  const seenName = new Set()
  const addName = (name, x, y, nid) => {
    if (!name || name.length < 2 || seenName.has(name)) return
    seenName.add(name)
    gaz.push({ name, x: +x, y: +y, nid: nid || null })
  }
  for (const p of mapLayers.places || []) addName(p.n, p.x, p.y, p.id)
  days.forEach(d => d.points.forEach(p => {
    if (p.venue && p.coord) addName(p.venue, p.coord[0], p.coord[1], titleToId[p.venue] || null)
  }))
  for (const p of mapLayers.peaks || []) addName(p.n, p.x, p.y, titleToId[p.n] || null)
  for (const p of mapLayers.pois || []) addName(p.n, p.x, p.y, titleToId[p.n] || null)
  gaz.sort((a, b) => b.name.length - a.name.length)

  /** 在问句中识别地名 */
  function detectPlaces(q) {
    const found = []
    let s = q
    for (const g of gaz) {
      if (s.includes(g.name)) {
        found.push(g)
        s = s.split(g.name).join('⌘')      // 防止子串重复命中（如 芦林湖/芦林湖大坝）
      }
      if (found.length >= 3) break
    }
    return found
  }

  // —— 图谱扩展：种子 = 问句中出现的节点标题 + 地名节点 ——
  function graphScores(q, placeHits) {
    const seeds = new Set()
    for (const n of nodes) {
      if (n.k === '索引') continue
      const t = n.t || n.id
      if (t.length >= 2 && q.includes(t)) seeds.add(n.id)
    }
    for (const g of placeHits) if (g.nid) seeds.add(g.nid)
    const dist = new Map()
    let frontier = [...seeds]
    frontier.forEach(id => dist.set(id, 0))
    for (let d = 1; d <= 2; d++) {
      const next = []
      for (const id of frontier) {
        for (const nb of adj.get(id) || []) {
          if (!dist.has(nb)) { dist.set(nb, d); next.push(nb) }
        }
      }
      frontier = next
    }
    const decay = [1, 0.55, 0.28]
    const byNode = new Map()
    for (const [id, d] of dist) byNode.set(id, decay[d])
    return { byNode, seeds }
  }

  // —— 主检索 ——
  const W_DEFAULT = { lex: 1.0, graph: 0.5, vector: 0, spatial: 0.6 }

  /**
   * @param {string} q 问句
   * @param {object} opt { coord:[x,y] 用户位置, weights, topK, perNote }
   * @returns { hits, anchor, places, spatialActive, seeds }
   */
  function search(q, opt = {}) {
    const W = { ...W_DEFAULT, ...(opt.weights || {}) }
    const topK = opt.topK || 8
    const perNote = opt.perNote || 2

    const placeHits = detectPlaces(q)
    const locative = LOCATIVE_RE.test(q)
    let anchor = null
    if (placeHits.length) anchor = [placeHits[0].x, placeHits[0].y]
    else if (opt.coord && locative) {
      anchor = opt.coord
      W.spatial = Math.max(W.spatial, 0.9)   // “脚下/附近”类问题以位置为主
    }
    const spatialActive = !!anchor && W.spatial > 0

    const lex = bm25(tokenize(q))
    const { byNode: gsc, seeds } = W.graph > 0 ? graphScores(q, placeHits) : { byNode: new Map(), seeds: new Set() }
    const vectorActive = W.vector > 0 && vecOf.size > 0 && typeof embedText === 'function'
    const queryVec = vectorActive ? embedText(q) : null

    // 候选：词法 top120 ∪ 图谱可达 ∪ 向量全库 ∪ 空间近邻
    const cand = new Set([...lex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120).map(e => e[0]))
    if (W.graph > 0) for (const c of chunks) if (gsc.has(c.nid)) cand.add(c.ci)
    if (vectorActive) for (const c of chunks) if (vecOf.has(c.nid)) cand.add(c.ci)
    if (spatialActive) for (const c of chunks)
      if (c.coord && haversine(anchor, c.coord) < 2500) cand.add(c.ci)

    let maxLex = 0
    for (const ci of cand) maxLex = Math.max(maxLex, lex.get(ci) || 0)

    // 意图感知的类型加权：问"讲了什么"偏向讲解点，问"是什么/成因"偏向概念与主线
    const wantsPoint = /讲了|讲过|讲解|讲的|哪些点|有什么点/.test(q)
    const wantsDef = /是什么|定义|为什么|怎么形成|成因|原理|机制/.test(q)

    const scored = []
    for (const ci of cand) {
      const c = chunks[ci]
      const sLex = maxLex ? (lex.get(ci) || 0) / maxLex : 0
      const sGraph = gsc.get(c.nid) || 0
      const sVec = vectorActive ? cosine(queryVec, vecOf.get(c.nid)) : 0
      let sSpa = 0, dist = null
      if (spatialActive && c.coord) {
        dist = haversine(anchor, c.coord)
        sSpa = Math.exp(-dist / 500)
      }
      let score = W.lex * sLex + W.graph * sGraph + W.vector * sVec +
        (spatialActive ? W.spatial * sSpa : 0)
      if (wantsPoint && c.kind === '讲解点') score *= 1.25
      else if (wantsDef && (c.kind === '概念' || c.kind === '主线')) score *= 1.12
      if (score <= 0.02) continue
      scored.push({ chunk: c, score, sLex, sGraph, sVec, sSpa, dist })
    }
    scored.sort((a, b) => b.score - a.score)

    // 每笔记至多 perNote 块
    const cnt = new Map(), hits = []
    for (const h of scored) {
      const k = h.chunk.nid
      if ((cnt.get(k) || 0) >= perNote) continue
      cnt.set(k, (cnt.get(k) || 0) + 1)
      hits.push(h)
      if (hits.length >= topK) break
    }
    return {
      hits, anchor, places: placeHits, spatialActive, vectorActive,
      seeds: [...seeds], locative,
    }
  }

  // —— 位置解读：脚下是什么 ——
  function locate(coord) {
    const hitOf = feats => {
      for (const f of feats || []) if (pointInPoly(coord, f.g)) return f.p
      return null
    }
    const geology = hitOf(mapLayers.geology)
    const soil = hitOf(mapLayers.soil)
    const vegetation = hitOf(mapLayers.vegetation)

    let fault = null
    for (const f of mapLayers.faults || []) {
      const d = distToLine(coord, f.g)
      if (!fault || d < fault.dist) fault = { p: f.p, dist: d }
    }
    const pts = []
    days.forEach((d, di) => d.points.forEach(p => {
      if (p.coord) pts.push({
        id: p.id, title: p.title, n: p.n, short: d.short, dayIdx: di,
        coord: p.coord, dist: haversine(coord, p.coord),
      })
    }))
    pts.sort((a, b) => a.dist - b.dist)
    const places = (mapLayers.places || [])
      .map(p => ({ id: p.id, n: p.n, dist: haversine(coord, [p.x, p.y]) }))
      .sort((a, b) => a.dist - b.dist)
    return { coord, geology, soil, vegetation, fault, nearestPoints: pts.slice(0, 3), nearestPlaces: places.slice(0, 2) }
  }

  // —— 离线抽取式回答 ——
  function bestSnippets(q, chunk, k = 2) {
    const qs = new Set(tokenize(q))
    const all = sentences(chunk.text)
      .filter(s => s.length >= 10 && !chunk.title.includes(s) && !s.includes(chunk.title)
        && s !== chunk.sec && !/^[一-鿿]{2,4}( [一-鿿]{2,4}){1,4}$/.test(s))
    const cands = all.map(s => {
      let ov = 0
      for (const t of tokenize(s)) if (qs.has(t)) ov++
      return { s, ov }
    }).filter(x => x.ov > 0)
    cands.sort((a, b) => b.ov - a.ov)
    let out = cands.slice(0, k).map(x => x.s)
    if (!out.length) out = all.slice(0, 1)
    return out.map(s => (s.length > 140 ? s.slice(0, 138) + '…' : s))
  }

  function extractive(q, res) {
    const cites = res.hits.slice(0, 5).map((h, i) => ({
      idx: i + 1, nid: h.chunk.nid, kind: h.chunk.kind, title: h.chunk.title,
      sec: h.chunk.sec, coord: h.chunk.coord, dist: h.dist,
      snips: bestSnippets(q, h.chunk),
      meta: pointMeta[h.chunk.nid] || null,
    }))
    return cites
  }

  // —— LLM 上下文构造 ——
  function llmContext(q, res, loc) {
    const parts = []
    if (loc) {
      const L = []
      if (loc.geology) L.push(`地质：${loc.geology.n || loc.geology.s}（${loc.geology.e}）${loc.geology.d ? '，' + String(loc.geology.d).slice(0, 60) : ''}`)
      if (loc.soil) L.push(`土壤：${loc.soil.n}`)
      if (loc.vegetation) L.push(`植被：${loc.vegetation.n}`)
      if (loc.fault && loc.fault.dist < 1500) L.push(`距最近断层约 ${Math.round(loc.fault.dist)} m`)
      for (const p of loc.nearestPoints) L.push(`距讲解点「${p.title}」(${p.short} 第${p.n}点) 约 ${Math.round(p.dist)} m`)
      parts.push(`【所在位置的空间查询结果】\n${L.join('\n')}`)
    }
    res.hits.slice(0, 6).forEach((h, i) => {
      const c = h.chunk
      const head = `[${i + 1}] ${c.kind}《${c.title}》${c.sec ? ' · ' + c.sec : ''}${h.dist != null ? `（距锚点约 ${Math.round(h.dist)} m）` : ''}`
      parts.push(`${head}\n${c.text.slice(0, 1300)}`)
    })
    return parts.join('\n\n')
  }

  return {
    chunks, search, locate, extractive, llmContext, detectPlaces,
    nodeById, coordOf, pointMeta, adj, titleToId,
    stats: { chunks: chunks.length, nodes: nodes.length, gaz: gaz.length, links: [...adj.values()].reduce((a, s) => a + s.size, 0) / 2 },
  }
}
