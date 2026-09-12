// 知识问答 · Agent 工具层（旧地理现场语料兼容；教务问答由 dsh-nwu 服务端注册同名工具）
// 把检索引擎的能力暴露成模型可调用的工具。所有工具都是本地纯函数——
// 查的是内嵌 JSON，零延迟、零后端，离线状态下工具照样能跑（只有生成那一步需要网）。
//
// 引用登记：每个被工具带出来的笔记按首次出现顺序拿到一个编号，工具结果里带 ref 字段，
// 模型用 [ref] 标注论断，UI 直接渲染这份登记表 —— 这样引用编号在多轮工具调用间保持稳定。

import { stripMd } from './engine.js'

export const TOOL_DEFS = [
  {
    name: 'retrieve',
    description:
      '在实习知识库里检索（词法 + 知识图谱 + 空间三路融合）。返回若干知识块的标题、小节名和摘要片段。' +
      '这是最常用的入口：先用它找到相关笔记，需要细节再用 read_note 读全文。' +
      '问句里带地名时会自动做空间加权。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问句或关键词，用中文' },
        topK: { type: 'integer', description: '返回条数，默认 8，最多 12' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description:
      '读取一篇笔记的完整正文（或指定小节）。retrieve 只给摘要片段，需要完整论述、' +
      '完整数据表、或者摘要里被截断的内容时用这个。先调 retrieve 拿到 id。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id，来自 retrieve 结果' },
        section: { type: 'string', description: '只读某个 ## 小节，省略则读全文' },
      },
      required: ['id'],
    },
  },
  {
    name: 'neighbors',
    description:
      '列出一篇笔记在知识图谱里的直接关联笔记（双向 wikilink）。用于回答关系型问题：' +
      '某个概念在哪些讲解点讲过、某个地点关联哪些物种、两个概念之间有没有联系。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id' },
        kind: {
          type: 'string',
          description: '只要某一类：讲解点 / 地点 / 概念 / 物种 / 气象 / 每日 / 主线',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'locate',
    description:
      '空间查询：给定经纬度，返回该点所在的地质单元（地层符号/时代/岩性）、土壤类型、' +
      '植被优势树种、到最近断层的距离，以及最近的几个讲解点和地点。' +
      '回答"脚下是什么""这里为什么长这种植被"必用。',
    input_schema: {
      type: 'object',
      properties: {
        lon: { type: 'number', description: '经度' },
        lat: { type: 'number', description: '纬度' },
      },
      required: ['lon', 'lat'],
    },
  },
  {
    name: 'weather',
    description:
      '取某一天的气象实测数据表（各测点海拔/气压/气温/湿度/风向风速）和气压—高程拟合式。' +
      '回答气压随高度变化、气温垂直递减率、山谷风之类的定量问题时用，不要靠文本检索猜数字。',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期，如 2026-07-09 或 7.9；省略则返回所有有气象数据的天' },
      },
    },
  },
  {
    name: 'itinerary',
    description:
      '实习行程总览：每天的日期、路线、海拔区间、讲解点清单（编号/标题/时刻/场所）。' +
      '用于回答"哪天去了哪里""第几个点讲了什么"这类需要先定位到具体日程的问题。',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '只看某一天，如 7.9；省略则返回全部' },
      },
    },
  },
]

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '')

/**
 * 每次提问创建一个实例（引用登记表是问题级的状态）。
 * @param {object} ctx { eng, nodes, days, mapLayers }
 */
export function createToolbox({ eng, nodes, days, mapLayers }) {
  const refs = []                       // [{idx, nid, title, kind, coord}]
  const refIdx = new Map()              // nid -> idx

  function ref(nid) {
    if (refIdx.has(nid)) return refIdx.get(nid)
    const n = eng.nodeById[nid]
    if (!n) return null
    const idx = refs.length + 1
    refIdx.set(nid, idx)
    refs.push({
      idx, nid, title: n.t || nid, kind: n.k,
      coord: eng.coordOf[nid] || null,
    })
    return idx
  }

  const dayOf = (key) => {
    if (!key) return null
    const s = String(key).trim()
    return days.find(d => d.date === s || d.short === s || d.key === s) || null
  }

  const TOOLS = {
    retrieve({ query, topK }) {
      const res = eng.search(String(query || ''), {
        topK: Math.min(Math.max(parseInt(topK) || 8, 1), 12),
      })
      const hits = res.hits.map(h => ({
        ref: ref(h.chunk.nid),
        id: h.chunk.nid,
        kind: h.chunk.kind,
        title: h.chunk.title,
        section: h.chunk.sec || undefined,
        snippet: clip(h.chunk.text.replace(/\n+/g, ' '), 260),
        distFromAnchor: h.dist == null ? undefined : Math.round(h.dist) + ' m',
      }))
      return {
        hits,
        anchor: res.anchor || undefined,
        placesDetected: res.places.map(p => p.name),
        note: hits.length ? undefined : '未检索到相关内容，换个说法或改用 itinerary / neighbors 探索',
      }
    },

    read_note({ id, section }) {
      const n = eng.nodeById[id]
      if (!n) return { error: `没有 id 为「${id}」的笔记；先用 retrieve 找到正确 id` }
      const parts = eng.chunks.filter(c => c.nid === id)
      const sections = parts.map(c => c.sec).filter(Boolean)
      if (section) {
        const hit = parts.find(c => c.sec === section) ||
          parts.find(c => c.sec && c.sec.includes(section))
        if (!hit) {
          return { error: `笔记「${n.t}」没有小节「${section}」`, availableSections: sections }
        }
        return { ref: ref(id), id, title: n.t, section: hit.sec, text: hit.text }
      }
      return {
        ref: ref(id), id, title: n.t, kind: n.k,
        date: n.date, time: n.time, altitude: n.alt,
        coord: eng.coordOf[id] || undefined,
        sections,
        text: stripMd(n.md).replace(/\n{3,}/g, '\n\n').trim(),
      }
    },

    neighbors({ id, kind }) {
      const n = eng.nodeById[id]
      if (!n) return { error: `没有 id 为「${id}」的笔记；先用 retrieve 找到正确 id` }
      const ids = [...(eng.adj.get(id) || [])]
      let out = ids.map(t => eng.nodeById[t]).filter(Boolean)
      if (kind) out = out.filter(x => x.k === kind)
      return {
        ref: ref(id), id, title: n.t, count: out.length,
        neighbors: out.slice(0, 40).map(x => ({
          ref: ref(x.id), id: x.id, title: x.t, kind: x.k,
          day: x.day, n: x.n,
        })),
      }
    },

    locate({ lon, lat }) {
      const x = Number(lon), y = Number(lat)
      if (!isFinite(x) || !isFinite(y)) return { error: 'lon/lat 必须是数字' }
      const L = eng.locate([x, y])
      return {
        coord: [x, y],
        geology: L.geology ? {
          unit: L.geology.n || undefined,
          symbol: L.geology.s || undefined,
          era: L.geology.e || undefined,
          lithology: clip(L.geology.d, 200) || undefined,
          metamorphic: L.geology.m && L.geology.m !== '无' ? L.geology.m : undefined,
        } : null,
        soil: L.soil ? L.soil.n : null,
        vegetation: L.vegetation ? L.vegetation.n : null,
        nearestFault: L.fault ? {
          name: L.fault.p.n || undefined,
          type: L.fault.p.t || undefined,
          distance: Math.round(L.fault.dist) + ' m',
        } : null,
        nearestPoints: L.nearestPoints.map(p => ({
          ref: ref(p.id), id: p.id, title: p.title,
          day: p.short, n: p.n, distance: Math.round(p.dist) + ' m',
        })),
        nearestPlaces: L.nearestPlaces.map(p => ({
          id: p.id, name: p.n, distance: Math.round(p.dist) + ' m',
        })),
      }
    },

    weather({ date }) {
      const list = date ? [dayOf(date)].filter(Boolean) : days
      const out = list.filter(d => d.wx && d.wx.rows.length).map(d => ({
        ref: d.wx.noteId ? ref(d.wx.noteId) : undefined,
        date: d.date, day: d.short,
        noteId: d.wx.noteId,
        intro: d.wx.intro || undefined,
        // 明确标注这是气压对高程的回归，避免被当成气温—海拔递减率误用
        气压高程拟合: d.wx.fit ? {
          式: `气压P(hPa) = ${d.wx.fit.a} − ${d.wx.fit.b} × 海拔H(m)`,
          r2: d.wx.fit.r2 ?? undefined,
          注: '这是气压随高程的回归，不是气温递减率；气温要看下表 气温C 列',
        } : undefined,
        rows: d.wx.rows.map(r => ({
          测点: r.loc, 讲解点: r.pt || undefined, 时刻: r.time,
          海拔: r.alt, 气压hPa: r.P, 气温C: r.T, 湿度: r.RH,
          露点: r.dew || undefined, 风向: r.wd || undefined, 风速: r.ws || undefined,
        })),
      }))
      if (!out.length) {
        return {
          error: date ? `${date} 没有气象实测数据` : '没有任何气象数据',
          daysWithWeather: days.filter(d => d.wx && d.wx.rows.length).map(d => d.short),
        }
      }
      return { days: out }
    },

    itinerary({ date }) {
      const list = date ? [dayOf(date)].filter(Boolean) : days
      if (!list.length) {
        return { error: `没有 ${date} 这一天`, availableDays: days.map(d => d.short) }
      }
      return {
        days: list.map(d => ({
          ref: d.dayNoteId ? ref(d.dayNoteId) : undefined,
          date: d.date, day: d.short, week: d.week,
          route: d.route || undefined,
          altRange: d.altRange || undefined,
          pointCount: d.points.length,
          summary: clip(d.summary, 200) || undefined,
          hasWeather: !!(d.wx && d.wx.rows.length),
          points: d.points.map(p => ({
            ref: ref(p.id), id: p.id, n: p.n, title: p.title,
            time: p.time || undefined, alt: p.alt || undefined,
            venue: p.venue || undefined,
            center: clip(p.center, 120) || undefined,
          })),
          roadside: d.roadside.length
            ? d.roadside.map(r => `${r.time} ${r.spot}${r.alt && r.alt !== '—' ? ` (${r.alt}m)` : ''}：${clip(r.note, 80)}`)
            : undefined,
        })),
      }
    },
  }

  return {
    defs: TOOL_DEFS,
    /** 执行一次工具调用；任何异常都转成 {error}，不让 agent 循环崩掉 */
    run(name, input) {
      const fn = TOOLS[name]
      if (!fn) return { error: `没有名为「${name}」的工具` }
      try {
        return fn(input || {})
      } catch (e) {
        return { error: `工具 ${name} 执行失败：${e && e.message ? e.message : String(e)}` }
      }
    },
    /** 引用登记表（供 UI 渲染引用列表和证据地图） */
    refs: () => refs.slice(),
  }
}
