import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 兼容旧地理现场知识类型；教务站点使用下面的教务类型。
const NODE_KINDS = new Set([
  '讲解点', '地点', '概念', '物种', '气象', '每日', '主线',
  '政策文件', '办事指南', '常见问题', '通知公告', '名词解释', '索引',
])
const SOURCE_KINDS = new Set(['text', 'document', 'image', 'audio', 'gis'])
const MAX_SOURCE_TEXT = 2_000_000
const MAX_NODE_CONTENT = 20_000

const now = () => new Date().toISOString()
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').trim()

/** 缺口去重键：同一问题的不同标点/空白写法归并为一条缺口。 */
function gapKey(question) {
  return String(question ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[。．.？?！!，,、；;：:…~～]+$/g, '')
    .toLowerCase()
}

function sourceView(source) {
  if (!source) return null
  const {
    storedPath: _storedPath,
    textPath: _textPath,
    structuredPath: _structuredPath,
    ...safe
  } = source
  return safe
}

function validateCoordinate(value) {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length !== 2) throw new Error('coordinate 必须是 [经度, 纬度]')
  const lon = Number(value[0]), lat = Number(value[1])
  if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('coordinate 超出合法经纬度范围')
  }
  return [lon, lat]
}

function normalizeNode(raw, sourceIds, position) {
  const title = normalizeText(raw?.title)
  const kind = normalizeText(raw?.kind)
  const content = normalizeText(raw?.content)
  if (title.length < 2 || title.length > 120) throw new Error(`第 ${position + 1} 个节点的 title 长度应为 2—120 字`)
  if (!NODE_KINDS.has(kind)) throw new Error(`第 ${position + 1} 个节点的 kind 不合法`)
  if (content.length < 20 || content.length > MAX_NODE_CONTENT) {
    throw new Error(`第 ${position + 1} 个节点的 content 长度应为 20—${MAX_NODE_CONTENT} 字`)
  }
  const relations = [...new Set((raw.relations || []).map(normalizeText).filter(Boolean))].slice(0, 80)
  const coordinate = validateCoordinate(raw.coordinate)
  const altitude = raw.altitude == null || raw.altitude === '' ? undefined : Number(raw.altitude)
  if (altitude !== undefined && !Number.isFinite(altitude)) throw new Error(`第 ${position + 1} 个节点的 altitude 必须是数字`)
  const stableKey = `${title}\n${kind}`
  const id = `learned-${sha256(stableKey).slice(0, 16)}`
  const sourceLines = sourceIds.map(sourceId => `- 来源编号：${sourceId}`).join('\n')
  const relationLines = relations.length ? `\n\n## 关联\n${relations.map(x => `[[${x}]]`).join(' · ')}` : ''
  const provenance = `\n\n## 来源\n${sourceLines}`
  return {
    id,
    k: kind,
    t: title,
    out: relations,
    content,
    relations,
    md: `# ${title}\n\n## 资料整理\n${content}${relationLines}${provenance}`,
    c: coordinate,
    date: raw.date ? normalizeText(raw.date) : undefined,
    time: raw.time ? normalizeText(raw.time) : undefined,
    alt: altitude,
    sources: sourceIds,
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  text_chars INTEGER NOT NULL,
  text TEXT,
  raw BLOB,
  structured TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  reprocessed_at TEXT
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  md TEXT,
  relations TEXT NOT NULL,
  coordinate TEXT,
  date TEXT,
  time TEXT,
  altitude REAL,
  revision INTEGER,
  draft_id TEXT,
  published_at TEXT,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_source ON graph_nodes(source);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_title ON graph_nodes(title);

CREATE TABLE IF NOT EXISTS graph_edges (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  source_title TEXT NOT NULL,
  target_title TEXT NOT NULL,
  edge_type TEXT NOT NULL DEFAULT 'knowledge',
  PRIMARY KEY (source, target)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target);

CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
`

/**
 * SQLite 图数据库 + 事件溯源：
 * - events：知识增量的唯一事实源（草稿、发布、缺口、来源重提取）；
 * - source_files：来源原件与提取正文；
 * - graph_nodes / graph_edges：基础知识与已发布知识构成的图谱。
 * 应用启动时从 SQLite 重放 events 恢复内存索引，再从 graph_nodes 建图检索引擎。
 */
let openStores = 0

export class KnowledgeStore {
  static get openCount() {
    return openStores
  }

  constructor(dataDir) {
    openStores += 1
    this.root = path.join(dataDir, 'knowledge')
    fs.mkdirSync(this.root, { recursive: true })
    this.dbPath = path.join(dataDir, 'nwu.sqlite')
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    this.replay()
    this.syncGraphFromState()
  }

  close() {
    if (!this.db) return
    try {
      this.db.close()
    } finally {
      openStores = Math.max(0, openStores - 1)
      this.db = null
    }
  }

  replay() {
    this.sources = new Map()
    this.drafts = new Map()
    this.published = new Map()
    this.publishedTitle = new Map()
    this.gaps = new Map()
    this.events = []
    const rows = this.db.prepare('SELECT payload FROM events ORDER BY seq ASC').all()
    for (const row of rows) {
      try {
        const event = JSON.parse(String(row.payload))
        this.applyEvent(event)
        this.events.push(event)
      } catch (error) {
        throw new Error(`SQLite 知识事件损坏：${error.message}`)
      }
    }
  }

  append(type, payload) {
    const event = { eventId: crypto.randomUUID(), type, at: now(), ...payload }
    this.db.prepare('INSERT INTO events (event_id, type, at, payload) VALUES (?, ?, ?, ?)')
      .run(event.eventId, event.type, event.at, JSON.stringify(event))
    this.applyEvent(event)
    this.events.push(event)
    return event
  }

  applyEvent(event) {
    if (event.type === 'source.imported') {
      this.sources.set(event.source.id, event.source)
      return
    }
    if (event.type === 'source.reprocessed') {
      const source = this.sources.get(event.sourceId)
      if (source) Object.assign(source, event.patch)
      return
    }
    if (event.type === 'draft.created') {
      this.drafts.set(event.draft.id, event.draft)
      return
    }
    if (event.type === 'draft.rejected') {
      const draft = this.drafts.get(event.draftId)
      if (draft) Object.assign(draft, { status: 'rejected', updatedAt: event.at, rejectionReason: event.reason })
      return
    }
    if (event.type === 'draft.published') {
      const draft = this.drafts.get(event.draftId)
      if (draft) Object.assign(draft, { status: 'published', updatedAt: event.at, publishedAt: event.at })
      for (const node of event.nodes || []) {
        const previousId = this.publishedTitle.get(node.t)
        if (previousId && previousId !== node.id) this.published.delete(previousId)
        this.published.set(node.id, node)
        this.publishedTitle.set(node.t, node.id)
      }
      return
    }
    if (event.type === 'gap.reported') {
      const existing = this.gaps.get(event.gapId)
      if (existing) {
        existing.count += 1
        existing.lastReportedAt = event.at
        if (event.note && !existing.notes.includes(event.note)) existing.notes.push(event.note)
        if (existing.status === 'resolved') {
          // 已解决后又被问到：重新打开，说明发布的知识仍没接住这个问题。
          existing.status = 'open'
          existing.resolution = undefined
          existing.resolvedAt = undefined
        }
      } else {
        this.gaps.set(event.gapId, {
          id: event.gapId,
          question: event.question,
          notes: event.note ? [event.note] : [],
          count: 1,
          status: 'open',
          firstReportedAt: event.at,
          lastReportedAt: event.at,
        })
      }
      return
    }
    if (event.type === 'gap.resolved') {
      const gap = this.gaps.get(event.gapId)
      if (gap) Object.assign(gap, { status: 'resolved', resolution: event.resolution, draftId: event.draftId, resolvedAt: event.at })
    }
  }

  // ---------------------------------------------------------- SQLite 图存储

  importBaseGraph(nodes) {
    if (!Array.isArray(nodes)) return
    const upsert = this.db.prepare(`
      INSERT INTO graph_nodes (
        id, title, kind, md, relations, coordinate, date, time, altitude,
        revision, draft_id, published_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'base')
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        md = excluded.md,
        relations = excluded.relations,
        coordinate = excluded.coordinate,
        date = excluded.date,
        time = excluded.time,
        altitude = excluded.altitude,
        source = 'base'
    `)
    const tx = this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM graph_edges').run()
      this.db.prepare("DELETE FROM graph_nodes WHERE source = 'base'").run()
      for (const node of nodes) {
        upsert.run(
          node.id,
          node.t || node.title || node.id,
          node.k || node.kind || '知识条目',
          node.md || node.content || '',
          JSON.stringify(node.out || node.relations || []),
          node.c ? JSON.stringify(node.c) : null,
          node.date || null,
          node.time || null,
          node.alt ?? null,
        )
      }
      this.rebuildEdges()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    void tx
  }

  syncGraphFromState() {
    const tx = this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const node of this.published.values()) this.upsertPublishedNode(node)
      this.rebuildEdges()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertPublishedNode(node) {
    if (!node) return
    this.db.prepare(`
      INSERT INTO graph_nodes (
        id, title, kind, md, relations, coordinate, date, time, altitude,
        revision, draft_id, published_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        md = excluded.md,
        relations = excluded.relations,
        coordinate = excluded.coordinate,
        date = excluded.date,
        time = excluded.time,
        altitude = excluded.altitude,
        revision = excluded.revision,
        draft_id = excluded.draft_id,
        published_at = excluded.published_at,
        source = 'published'
    `).run(
      node.id,
      node.t || node.title || node.id,
      node.k || node.kind || '知识条目',
      node.md || node.content || '',
      JSON.stringify(node.out || node.relations || []),
      node.c ? JSON.stringify(node.c) : null,
      node.date || null,
      node.time || null,
      node.alt ?? null,
      node.revision ?? null,
      node.draftId || null,
      node.publishedAt || null,
    )
  }

  rebuildEdges() {
    const rows = this.db.prepare('SELECT id, title, relations FROM graph_nodes').all()
    const byTitle = new Map()
    for (const row of rows) if (!byTitle.has(row.title)) byTitle.set(row.title, row.id)
    this.db.prepare('DELETE FROM graph_edges').run()
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO graph_edges (source, target, source_title, target_title, edge_type)
      VALUES (?, ?, ?, ?, 'knowledge')
    `)
    for (const row of rows) {
      let relations = []
      try { relations = JSON.parse(String(row.relations || '[]')) } catch { relations = [] }
      for (const title of relations) {
        const targetId = byTitle.get(title)
        if (!targetId || targetId === row.id) continue
        insert.run(row.id, targetId, row.title, title)
      }
    }
  }

  graphNodes() {
    const rows = this.db.prepare(`
      SELECT id, title, kind, md, relations, coordinate, date, time, altitude,
             revision, draft_id, published_at, source
      FROM graph_nodes
      ORDER BY source = 'base' DESC, COALESCE(revision, 0) ASC
    `).all()
    return rows.map(row => {
      let relations = []
      try { relations = JSON.parse(String(row.relations || '[]')) } catch { relations = [] }
      const node = {
        id: row.id,
        t: row.title,
        k: row.kind,
        out: relations,
        md: row.md || '',
      }
      if (row.coordinate) {
        try { node.c = JSON.parse(row.coordinate) } catch { /* ignore */ }
      }
      if (row.date) node.date = row.date
      if (row.time) node.time = row.time
      if (row.altitude != null) node.alt = row.altitude
      if (row.revision != null) node.revision = row.revision
      if (row.draft_id) node.draftId = row.draft_id
      if (row.published_at) node.publishedAt = row.published_at
      node.graphSource = row.source
      return node
    })
  }

  graphStats() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS nodes,
        SUM(source = 'base') AS base,
        SUM(source = 'published') AS published
      FROM graph_nodes
    `).get()
    const edge = this.db.prepare('SELECT COUNT(*) AS n FROM graph_edges').get()
    return {
      nodes: Number(row?.nodes || 0),
      base: Number(row?.base || 0),
      published: Number(row?.published || 0),
      edges: Number(edge?.n || 0),
    }
  }

  saveNodeEmbeddings(rows) {
    if (!Array.isArray(rows)) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO node_embeddings (node_id, dim, vector, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    const updatedAt = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        if (!row?.id || !row.vector) continue
        stmt.run(row.id, row.dim || row.vector.length, Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), updatedAt)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  loadNodeEmbeddings() {
    const rows = this.db.prepare('SELECT node_id, dim, vector FROM node_embeddings').all()
    const map = new Map()
    for (const row of rows) {
      const buffer = Buffer.from(row.vector)
      const dim = Number(row.dim || Math.floor(buffer.length / 4))
      const vec = new Float32Array(buffer.buffer, buffer.byteOffset, dim)
      map.set(row.node_id, vec)
    }
    return map
  }

  // ---------------------------------------------------------- 来源与正文

  importSource({ name, buffer, text = '', mediaType = 'application/octet-stream', kind = 'document', metadata = {}, structured }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('资料内容为空')
    if (!SOURCE_KINDS.has(kind)) throw new Error(`不支持的资料类型：${kind}`)
    const extracted = normalizeText(text)
    if (extracted.length > MAX_SOURCE_TEXT) throw new Error(`提取文本超过 ${MAX_SOURCE_TEXT} 字限制`)
    const hash = sha256(buffer)
    const id = `src-${hash.slice(0, 16)}`
    const existing = this.sources.get(id)
    if (existing) {
      if (existing.metadata?.extractionError && !metadata?.extractionError) {
        const patch = {
          textChars: extracted.length,
          metadata,
          reprocessedAt: now(),
        }
        this.db.prepare(`
          UPDATE source_files
          SET text = ?, structured = ?, metadata = ?, text_chars = ?, reprocessed_at = ?
          WHERE id = ?
        `).run(
          extracted,
          structured == null ? null : JSON.stringify(structured),
          JSON.stringify(metadata),
          extracted.length,
          patch.reprocessedAt,
          id,
        )
        this.append('source.reprocessed', { sourceId: id, patch })
        return { source: sourceView(this.sources.get(id)), duplicate: false, reprocessed: true }
      }
      return { source: sourceView(existing), duplicate: true, reprocessed: false }
    }

    const source = {
      id,
      hash,
      name: normalizeText(name) || `${id}.bin`,
      mediaType: normalizeText(mediaType) || 'application/octet-stream',
      kind,
      size: buffer.length,
      textChars: extracted.length,
      metadata,
      createdAt: now(),
    }
    this.db.prepare(`
      INSERT INTO source_files (
        id, hash, name, media_type, kind, size, text_chars,
        text, raw, structured, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, hash, source.name, source.mediaType, kind, buffer.length, extracted.length,
      extracted, buffer,
      structured == null ? null : JSON.stringify(structured),
      JSON.stringify(metadata),
      source.createdAt,
    )
    this.append('source.imported', { source })
    return { source: sourceView(source), duplicate: false, reprocessed: false }
  }

  importText({ name = '对话资料.txt', text, metadata = {} }) {
    const normalized = normalizeText(text)
    return this.importSource({
      name,
      buffer: Buffer.from(normalized, 'utf8'),
      text: normalized,
      mediaType: 'text/plain; charset=utf-8',
      kind: 'text',
      metadata,
    })
  }

  listSources() {
    const usedBy = new Map()
    for (const draft of this.drafts.values()) {
      for (const sourceId of draft.sourceIds) {
        const row = usedBy.get(sourceId) || []
        row.push({ draftId: draft.id, status: draft.status })
        usedBy.set(sourceId, row)
      }
    }
    return [...this.sources.values()].reverse().map(source => ({
      ...sourceView(source),
      usedBy: usedBy.get(source.id) || [],
    }))
  }

  readSource(id, offset = 0, limit = 12_000) {
    const source = this.sources.get(id)
    if (!source) throw new Error(`没有编号为「${id}」的资料`)
    const row = this.db.prepare('SELECT text, structured FROM source_files WHERE id = ?').get(id)
    const full = String(row?.text || '')
    const start = Math.max(0, Math.min(Number(offset) || 0, full.length))
    const size = Math.max(200, Math.min(Number(limit) || 12_000, 30_000))
    let structuredPreview
    if (row?.structured) {
      try {
        const structured = JSON.parse(row.structured)
        structuredPreview = JSON.stringify(structured).slice(0, 8_000)
      } catch { /* ignore */ }
    }
    return {
      source: sourceView(source),
      text: full.slice(start, start + size),
      offset: start,
      nextOffset: start + size < full.length ? start + size : undefined,
      totalChars: full.length,
      structuredPreview,
    }
  }

  // ---------------------------------------------------------- 草稿与发布

  createDraft({ title, summary = '', sourceIds, nodes }) {
    const ids = [...new Set((sourceIds || []).map(normalizeText).filter(Boolean))]
    if (!ids.length) throw new Error('草稿至少需要一个 sourceId')
    for (const id of ids) if (!this.sources.has(id)) throw new Error(`没有编号为「${id}」的资料`)
    if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) throw new Error('nodes 数量应为 1—100')
    const normalizedNodes = nodes.map((node, index) => normalizeNode(node, ids, index))
    const seen = new Set()
    for (const node of normalizedNodes) {
      if (seen.has(node.t)) throw new Error(`草稿内存在重复标题「${node.t}」`)
      seen.add(node.t)
    }
    const createdAt = now()
    const draft = {
      id: `draft-${crypto.randomUUID().slice(0, 8)}`,
      title: normalizeText(title) || `知识草稿 ${createdAt.slice(0, 10)}`,
      summary: normalizeText(summary),
      sourceIds: ids,
      nodes: normalizedNodes,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    }
    this.append('draft.created', { draft })
    return this.draftView(draft)
  }

  draftView(draft) {
    if (!draft) return null
    return {
      ...draft,
      sources: draft.sourceIds.map(id => sourceView(this.sources.get(id))).filter(Boolean),
      confirmation: draft.status === 'pending' ? `确认发布 ${draft.id}` : undefined,
    }
  }

  listDrafts(status) {
    return [...this.drafts.values()].reverse()
      .filter(draft => !status || draft.status === status)
      .map(draft => this.draftView(draft))
  }

  getDraft(id) {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    return this.draftView(draft)
  }

  rejectDraft(id, reason = '') {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    if (draft.status !== 'pending') throw new Error(`草稿状态为 ${draft.status}，不能驳回`)
    this.append('draft.rejected', { draftId: id, reason: normalizeText(reason) })
    return this.getDraft(id)
  }

  publishDraft(id, confirmation) {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error(`没有编号为「${id}」的草稿`)
    if (draft.status !== 'pending') throw new Error(`草稿状态为 ${draft.status}，不能发布`)
    if (normalizeText(confirmation) !== `确认发布 ${id}`) throw new Error(`需要用户明确发送“确认发布 ${id}”`)
    const revision = this.events.filter(e => e.type === 'draft.published').length + 1
    const publishedAt = now()
    const nodes = draft.nodes.map(node => ({
      ...node,
      revision,
      draftId: id,
      publishedAt,
    }))
    this.append('draft.published', { draftId: id, revision, nodes })
    for (const node of nodes) this.upsertPublishedNode(node)
    this.rebuildEdges()
    return { draft: this.getDraft(id), revision, nodes }
  }

  publishedNodes() {
    return [...this.published.values()]
  }

  // ---------------------------------------------------------- 知识缺口

  reportGap({ question, note = '' }) {
    const q = normalizeText(question)
    if (q.length < 4 || q.length > 500) throw new Error('question 长度应为 4—500 字')
    const key = gapKey(q)
    if (!key) throw new Error('question 不能为空')
    if (this.gaps.size >= 2000 && !this.gaps.has(`gap-${sha256(key).slice(0, 16)}`)) {
      throw new Error('知识缺口数量已达上限，请先在知识维护模式清理')
    }
    const gapId = `gap-${sha256(key).slice(0, 16)}`
    this.append('gap.reported', { gapId, question: q, note: normalizeText(note).slice(0, 300) || undefined })
    return { ...this.gaps.get(gapId) }
  }

  listGaps(status) {
    return [...this.gaps.values()]
      .filter(gap => !status || gap.status === status)
      .sort((a, b) => (b.status === 'open') - (a.status === 'open')
        || b.count - a.count
        || String(b.lastReportedAt).localeCompare(String(a.lastReportedAt)))
      .map(gap => ({ ...gap }))
  }

  resolveGap(id, resolution, draftId) {
    const gap = this.gaps.get(id)
    if (!gap) throw new Error(`没有编号为「${id}」的知识缺口`)
    if (gap.status === 'resolved') throw new Error('这条缺口已经处理过了')
    const reason = normalizeText(resolution)
    if (!reason) throw new Error('必须说明如何解决了这条缺口（发布了哪份草稿，或为何不补）')
    this.append('gap.resolved', { gapId: id, resolution: reason.slice(0, 300), draftId: draftId ? normalizeText(draftId) : undefined })
    return { ...this.gaps.get(id) }
  }

  stats() {
    const drafts = [...this.drafts.values()]
    const gaps = [...this.gaps.values()]
    return {
      sources: this.sources.size,
      pendingDrafts: drafts.filter(x => x.status === 'pending').length,
      publishedDrafts: drafts.filter(x => x.status === 'published').length,
      rejectedDrafts: drafts.filter(x => x.status === 'rejected').length,
      publishedNodes: this.published.size,
      openGaps: gaps.filter(x => x.status === 'open').length,
      resolvedGaps: gaps.filter(x => x.status === 'resolved').length,
      events: this.events.length,
    }
  }
}
