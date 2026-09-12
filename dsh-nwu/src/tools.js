// dsh-nwu · 知识问答只读工具（教务问答 / 地理现场两种站点形态共用）
//
// 1. 每个工具拆成三层：execute 返回 canonical JSON（程序化 API，供代码模式）、
//    output.render 生成模型可见文本、presentCall/presentResult 生成 UI 卡片。
// 2. 引用机制从"问题级 [n] 编号登记表"升级为"标题引用"：工具结果里的 title
//    字段即引用锚点，模型用《标题》标注论断——dsh 的 tool/result 是持久会话事件，
//    标题引用在回放后依然可追溯（[n] 编号只活在模型上下文里，违反
//    "model-visible means logged" 原则）。
// 3. 参数校验交给 defineTool 运行时；业务性失败（查无此天/查无此 id）作为
//    带 error 字段的合法返回值，符合 dsh "domain outcome 进 canonical value" 契约。
// 4. 数据经闭包注入：buildToolDefs(nwuData) 工厂在插件 apply 时构建，
//    工具执行体只拿 (args, exec)，符合 dsh 注册契约。
import { stripMd } from '../../dsh-georag/src/engine.js'

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '')

const text = (s) => [{ type: 'text', text: s }]

/**
 * 递归净化返回值，保证 lossless JSON：
 * 剥掉 undefined 属性、非有限数（NaN/Infinity）——它们会让 dsh-tools
 * 的 isJsonValue 校验失败（"value is not lossless JSON" → isError）。
 */
const clean = (v) => {
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue
      if (typeof x === 'number' && !Number.isFinite(x)) continue
      out[k] = clean(x)
    }
    return out
  }
  return v
}

/**
 * 数值强制转换：数据文件里 alt/P/T/RH 等常是数字字符串（"1088"、"889.6"），
 * 还可能带单位后缀（"1050m"）或全角括号标注的修正读数（"（31.2）"）。
 * 先剥掉非数字字符再 parseFloat，失败/空返回 undefined（clean 会剥离）。
 * schema 里是 number，必须先转换再过校验。
 */
const num = (x) => {
  if (x == null || x === '') return undefined
  const s = typeof x === 'number' ? String(x) : String(x).replace(/[^\d.\-+eE]/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

/** 模型可见的命中条目文本（不带编号，引用锚点是《条目标题》） */
const hitLine = (h, i) =>
  `《${h.title}》(${h.kind}${h.section ? ' · ' + h.section : ''}${h.dist != null ? ` · 距锚点约 ${h.dist} m` : ''}) — ${h.snippet}` +
  (h.sourceNames?.length ? `\n  原始来源：${h.sourceNames.join('、')}` : '')

/**
 * @param {object} nwuData - ctx.nwuData 服务实例（engine / site / days / …）
 */
export function buildToolDefs(nwuData) {
  const dayOf = (key) => {
    if (!key) return null
    const s = String(key).trim()
    return nwuData.days.find(d => d.date === s || d.short === s || d.key === s) || null
  }

  const office = nwuData.site?.domain && nwuData.site.domain !== 'field'
  const fieldOnly = !office && (
    nwuData.site?.domain === 'field' ||
    (nwuData.days && nwuData.days.length) ||
    Object.keys(nwuData.map?.layers || {}).length > 0
  )

  const tools = [
    {
      name: 'retrieve',
      description:
        (office
          ? '在教务知识库中检索（词法 + 知识图谱 + 向量嵌入三路融合）。返回若干条目的标题、小节名和摘要片段。'
          : '在知识库中检索（词法 + 知识图谱 + 向量嵌入 + 可选空间加权）。返回若干知识块的标题、小节名和摘要片段。') +
        '这是最常用的入口：先用它找到相关条目，需要细节再用 read_note 读全文。',
      parameters: {
        query: { type: 'string', required: true, description: '检索问句或关键词，用中文' },
        topK: { type: 'number', description: '返回条数，默认 8，最多 12' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            hits: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  kind: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  section: { type: 'string' },
                  snippet: { type: 'string', required: true },
                  dist: { type: 'number' },
                  coord: { type: 'array', items: { type: 'number' } },
                  sourceNames: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            placesDetected: { type: 'array', items: { type: 'string' } },
            anchor: { type: 'array', items: { type: 'number' } },
            note: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`检索失败：${v.error}`)
          const head = `检索「${v.query}」命中 ${v.hits.length} 条` +
            (v.placesDetected?.length ? `，识别地名：${v.placesDetected.join(' / ')}` : '') + '：'
          return text([head, ...v.hits.map(hitLine)].join('\n'))
        },
      },
      concurrencySafe: true,
      execute(args) {
        const query = String(args.query || '').trim()
        if (!query) return clean({ error: 'query 不能为空', query, hits: [] })
        const res = nwuData.engine.search(query, {
          topK: Math.min(Math.max(parseInt(args.topK) || 8, 1), 12),
          weights: { lex: 1, graph: 0.5, vector: 0.4 },
        })
        const hits = res.hits.map(h => {
          const node = nwuData.engine.nodeById[h.chunk.nid]
          return {
            ref: h.chunk.nid,
            kind: h.chunk.kind,
            title: h.chunk.title,
            section: h.chunk.sec || undefined,
            snippet: clip(h.chunk.text.replace(/\n+/g, ' '), 260),
            dist: h.dist == null ? undefined : Math.round(h.dist),
            coord: h.chunk.coord || undefined,
            sourceNames: node?.sources?.map(id => nwuData.knowledge.sources.get(id)?.name || id),
          }
        })
        return clean({
          query,
          hits,
          placesDetected: res.places.map(p => p.name),
          anchor: res.anchor || undefined,
          note: hits.length ? undefined : '未检索到相关内容，换个说法或改用 neighbors 探索相邻条目',
        })
      },
      presentCall(args) {
        return { card: 'generic', title: `检索「${args.query}」` }
      },
      presentResult(args, { content }) {
        return { card: 'generic', title: `检索「${args.query}」`, content }
      },
    },

    {
      name: 'read_note',
      description:
        '读取一个条目的完整正文（或指定小节）。retrieve 只给摘要片段，需要完整政策要点、' +
        '办事步骤或被截断的内容时用这个。先调 retrieve 拿到 id。',
      parameters: {
        id: { type: 'string', required: true, description: '笔记 id，来自 retrieve 结果' },
        section: { type: 'string', description: '只读某个 ## 小节，省略则读全文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string' },
            section: { type: 'string' },
            text: { type: 'string' },
            sections: { type: 'array', items: { type: 'string' } },
            coord: { type: 'array', items: { type: 'number' } },
            date: { type: 'string' },
            time: { type: 'string' },
            alt: { type: 'number' },
            sources: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`读取失败：${v.error}`)
          return text(v.section
            ? `《${v.title}》· ${v.section}\n\n${v.text}`
            : `《${v.title}》全文（${v.text.length} 字）\n\n${v.text}`)
        },
        presentationMeta: (_args, v) => clean({
          title: v.title ?? undefined,
          section: v.section ?? undefined,
          textLen: v.text?.length ?? 0,
          error: v.error ?? undefined,
        }),
      },
      concurrencySafe: true,
      execute(args) {
        const engine = nwuData.engine
        const n = engine.nodeById[args.id]
        if (!n) return clean({ error: `没有 id 为「${args.id}」的条目；先用 retrieve 找到正确 id` })
        const parts = engine.chunks.filter(c => c.nid === args.id)
        const sections = [...new Set(parts.map(c => c.sec).filter(Boolean))]
        if (args.section) {
          const hit = parts.find(c => c.sec === args.section) ||
            parts.find(c => c.sec && c.sec.includes(args.section))
          if (!hit) return clean({ error: `条目「${n.t}」没有小节「${args.section}」`, sections })
          return clean({ ref: args.id, title: n.t, section: hit.sec, text: hit.text })
        }
        return clean({
          ref: args.id, title: n.t, kind: n.k,
          date: n.date, time: n.time, alt: num(n.alt),
          coord: engine.coordOf[args.id] || undefined,
          sources: n.sources?.map(id => nwuData.knowledge.sources.get(id)?.name || id),
          sections,
          text: stripMd(n.md).replace(/\n{3,}/g, '\n\n').trim(),
        })
      },
      presentCall(args) {
        return { card: 'generic', title: `读条目 ${args.id}` }
      },
      presentResult(args, { content, meta }) {
        if (meta?.error) return { card: 'generic', title: `读条目 ${args.id}`, content }
        const title = meta?.title ?? `读条目 ${args.id}`
        const len = meta?.textLen ?? 0
        const body = content?.[0]?.text
        return {
          card: 'generic',
          title,
          content: body
            ? text(clip(body, 400) + (len > 400 ? `\n…（共 ${len} 字）` : ''))
            : content,
        }
      },
    },

    {
      name: 'neighbors',
      description:
        '列出一个条目在知识图谱里的直接关联条目（双向 wikilink）。用于回答关系型问题：' +
        '某项政策关联哪些办事指南、某个事项有哪些常见问题、两个概念/文件之间有没有联系。',
      parameters: {
        id: { type: 'string', required: true, description: '条目 id' },
        kind: {
          type: 'string',
          description: '只要某一类：政策文件 / 办事指南 / 常见问题 / 通知公告 / 名词解释',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string' },
            title: { type: 'string' },
            count: { type: 'number' },
            neighbors: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  kind: { type: 'string' },
                  day: { type: 'string' },
                  n: { type: 'number' },
                },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`查询失败：${v.error}`)
          const head = `《${v.title}》在知识图谱里有 ${v.count} 个直接关联` +
            (args.kind ? `（${args.kind}）` : '') + '：'
          return text([head, ...v.neighbors.map((x, i) =>
            `${i + 1}. 《${x.title}》(${x.kind}${x.day ? ` · ${x.day}` : ''}${x.n != null ? ` #${x.n}` : ''})`,
          )].join('\n'))
        },
        presentationMeta: (_args, v) => clean({ title: v.title, count: v.count, error: v.error }),
      },
      concurrencySafe: true,
      execute(args) {
        const engine = nwuData.engine
        const n = engine.nodeById[args.id]
        if (!n) return clean({ error: `没有 id 为「${args.id}」的条目；先用 retrieve 找到正确 id` })
        const ids = [...(engine.adj.get(args.id) || [])]
        let out = ids.map(t => engine.nodeById[t]).filter(Boolean)
        if (args.kind) out = out.filter(x => x.k === args.kind)
        return clean({
          ref: args.id,
          title: n.t,
          count: out.length,
          neighbors: out.slice(0, 40).map(x => ({
            ref: x.id, title: x.t, kind: x.k,
            day: x.day, n: x.n,
          })),
        })
      },
      presentResult(args, { content, meta }) {
        return {
          card: 'generic',
          title: meta?.error ? '图谱关联' : `《${meta?.title ?? args.id}》的关联条目（${meta?.count ?? '?'}）`,
          content,
        }
      },
    },

    {
      name: 'locate',
      description:
        '空间查询：给定经纬度，返回该点所在的地质单元（地层符号/时代/岩性）、土壤类型、' +
        '植被优势树种、到最近断层的距离，以及最近的几个讲解点和地点。' +
        '回答"脚下是什么""这里为什么长这种植被"必用。',
      parameters: {
        lon: { type: 'number', required: true, description: '经度' },
        lat: { type: 'number', required: true, description: '纬度' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            coord: { type: 'array', items: { type: 'number' } },
            geology: {
              type: 'object', additionalProperties: false,
              properties: {
                unit: { type: 'string' }, symbol: { type: 'string' }, era: { type: 'string' },
                lithology: { type: 'string' }, metamorphic: { type: 'string' },
              },
            },
            soil: { type: 'string' },
            vegetation: { type: 'string' },
            nearestFault: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, type: { type: 'string' }, distance: { type: 'number' } },
            },
            nearestPoints: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string' }, title: { type: 'string', required: true },
                  day: { type: 'string' }, n: { type: 'number' }, distance: { type: 'number', required: true },
                },
              },
            },
            nearestPlaces: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                properties: { name: { type: 'string', required: true }, distance: { type: 'number', required: true } },
              },
            },
            error: { type: 'string' },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`查询失败：${v.error}`)
          const L = []
          if (v.geology) {
            L.push(`地质：${v.geology.unit || v.geology.symbol || '—'}（${v.geology.era || '时代未知'}）` +
              (v.geology.lithology ? `，${v.geology.lithology}` : ''))
          }
          if (v.soil) L.push(`土壤：${v.soil}`)
          if (v.vegetation) L.push(`植被：${v.vegetation}`)
          if (v.nearestFault && v.nearestFault.distance < 1500) {
            L.push(`距最近断层「${v.nearestFault.name || '—'}」约 ${v.nearestFault.distance} m`)
          }
          for (const p of v.nearestPoints) {
            L.push(`距讲解点「${p.title}」(${p.day ?? ''} 第${p.n ?? '?'}点) 约 ${p.distance} m`)
          }
          return text(L.length ? L.join('\n') : '该点未命中任何图层')
        },
        presentationMeta: (_args, v) => clean({
          coord: v.coord ?? undefined,
          geology: v.geology?.unit ?? v.geology?.symbol ?? undefined,
          soil: v.soil ?? undefined,
          vegetation: v.vegetation ?? undefined,
          points: v.nearestPoints?.map(p => ({ title: p.title, distance: p.distance })) ?? [],
          error: v.error ?? undefined,
        }),
      },
      concurrencySafe: true,
      execute(args) {
        const x = Number(args.lon), y = Number(args.lat)
        if (!isFinite(x) || !isFinite(y)) return clean({ error: 'lon/lat 必须是数字' })
        const L = nwuData.engine.locate([x, y])
        return clean({
          coord: [x, y],
          geology: L.geology ? {
            unit: L.geology.n || undefined,
            symbol: L.geology.s || undefined,
            era: L.geology.e || undefined,
            lithology: clip(L.geology.d, 200) || undefined,
            metamorphic: L.geology.m && L.geology.m !== '无' ? L.geology.m : undefined,
          } : undefined,
          soil: L.soil?.n || undefined,
          vegetation: L.vegetation?.n || undefined,
          nearestFault: L.fault ? {
            name: L.fault.p.n || undefined,
            type: L.fault.p.t || undefined,
            distance: Math.round(L.fault.dist),
          } : undefined,
          nearestPoints: L.nearestPoints.map(p => ({
            ref: p.id, title: p.title, day: p.short, n: p.n, distance: Math.round(p.dist),
          })),
          nearestPlaces: L.nearestPlaces.map(p => ({ name: p.n, distance: Math.round(p.dist) })),
        })
      },
      presentCall(args) {
        return { card: 'generic', title: `定位 (${args.lon}, ${args.lat})` }
      },
      presentResult(args, { content }) {
        return { card: 'generic', title: '位置解读', content }
      },
    },

    {
      name: 'weather',
      description:
        '取某一天的气象实测数据表（各测点海拔/气压/气温/湿度/风向风速）和气压—高程拟合式。' +
        '回答气压随高度变化、气温垂直递减率、山谷风之类的定量问题时用，不要靠文本检索猜数字。',
      parameters: {
        date: { type: 'string', description: '日期，如 2026-07-09 或 7.9；省略则返回所有有气象数据的天' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string' },
                  date: { type: 'string', required: true },
                  day: { type: 'string', required: true },
                  intro: { type: 'string' },
                  fit: {
                    type: 'object', additionalProperties: false,
                    properties: { a: { type: 'number', required: true }, b: { type: 'number', required: true }, r2: { type: 'number' } },
                  },
                  rows: {
                    type: 'array', required: true,
                    items: {
                      type: 'object', additionalProperties: false,
                      properties: {
                        loc: { type: 'string', required: true }, pt: { type: 'string' },
                        time: { type: 'string', required: true }, alt: { type: 'number', required: true },
                        P: { type: 'number', required: true }, T: { type: 'number', required: true },
                        RH: { type: 'number', required: true }, dew: { type: 'number' },
                        wd: { type: 'string' }, ws: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
            error: { type: 'string' },
            daysWithWeather: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`无数据：${v.error}`)
          const blocks = []
          for (const d of v.days) {
            const lines = [`—— ${d.day}（${d.date}）气象实测 ——`]
            if (d.intro) lines.push(d.intro)
            if (d.fit) {
              lines.push(`气压P(hPa) = ${d.fit.a} − ${d.fit.b} × 海拔H(m)` +
                (d.fit.r2 != null ? `（R²=${d.fit.r2}）` : '') +
                ' —— 注意：这是气压对高程的回归，不是气温递减率')
            }
            for (const r of d.rows) {
              lines.push(`${r.loc}${r.pt ? `（${r.pt}）` : ''} ${r.time}：海拔${r.alt}m，气压${r.P}hPa，气温${r.T}℃，湿度${r.RH}%` +
                (r.dew != null ? `，露点${r.dew}℃` : '') +
                (r.wd ? `，${r.wd}${r.ws != null ? ` ${r.ws}m/s` : ''}` : ''))
            }
            blocks.push(lines.join('\n'))
          }
          return text(blocks.join('\n\n'))
        },
        presentationMeta: (_args, v) => clean({
          days: v.days?.map(d => d.day) ?? [],
          error: v.error ?? undefined,
        }),
      },
      concurrencySafe: true,
      execute(args) {
        const days = nwuData.days
        const list = args.date ? [dayOf(args.date)].filter(Boolean) : days
        const out = list.filter(d => d.wx && d.wx.rows.length).map(d => ({
          ref: d.wx.noteId || undefined,
          date: d.date, day: d.short,
          intro: d.wx.intro || undefined,
          fit: d.wx.fit ? {
            a: d.wx.fit.a, b: d.wx.fit.b,
            r2: num(d.wx.fit.r2),
          } : undefined,
          rows: d.wx.rows.map(r => ({
            loc: r.loc, pt: r.pt ? String(r.pt) : undefined, time: r.time,
            alt: num(r.alt), P: num(r.P), T: num(r.T), RH: num(r.RH),
            dew: num(r.dew), wd: r.wd || undefined, ws: num(r.ws),
          })),
        }))
        if (!out.length) {
          return clean({
            error: args.date ? `${args.date} 没有气象实测数据` : '没有任何气象数据',
            days: [],
            daysWithWeather: days.filter(d => d.wx && d.wx.rows.length).map(d => d.short),
          })
        }
        return clean({ days: out })
      },
      presentResult(args, { content, meta }) {
        return {
          card: 'generic',
          title: meta?.error ? '气象数据' : `气象实测 · ${meta?.days?.join('/') ?? ''}`,
          content,
        }
      },
    },

    {
      name: 'itinerary',
      description:
        '实习行程总览：每天的日期、路线、海拔区间、讲解点清单（编号/标题/时刻/场所）。' +
        '用于回答"哪天去了哪里""第几个点讲了什么"这类需要先定位到具体日程的问题。',
      parameters: {
        date: { type: 'string', description: '只看某一天，如 7.9；省略则返回全部' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string' },
                  date: { type: 'string', required: true },
                  day: { type: 'string', required: true },
                  week: { type: 'string' },
                  route: { type: 'string' },
                  altRange: { type: 'string' },
                  pointCount: { type: 'number', required: true },
                  summary: { type: 'string' },
                  hasWeather: { type: 'boolean' },
                  points: {
                    type: 'array', required: true,
                    items: {
                      type: 'object', additionalProperties: false,
                      properties: {
                        ref: { type: 'string' }, n: { type: 'number', required: true },
                        title: { type: 'string', required: true }, time: { type: 'string' },
                        alt: { type: 'number' }, venue: { type: 'string' }, center: { type: 'string' },
                      },
                    },
                  },
                  roadside: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            error: { type: 'string' },
            availableDays: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (args, v) => {
          if (v.error) return text(`无数据：${v.error}`)
          const blocks = []
          for (const d of v.days) {
            const lines = [`—— ${d.day}（${d.date}${d.week ? ' ' + d.week : ''}）——`]
            if (d.route) lines.push(`路线：${d.route}`)
            if (d.altRange) lines.push(`海拔区间：${d.altRange}`)
            if (d.summary) lines.push(d.summary)
            for (const p of d.points) {
              lines.push(`第${p.n}点 ${p.title}${p.time ? `（${p.time}）` : ''}` +
                (p.alt ? ` 海拔${p.alt}m` : '') + (p.venue ? ` @${p.venue}` : ''))
            }
            if (d.roadside?.length) lines.push(`沿途：${d.roadside.join('；')}`)
            blocks.push(lines.join('\n'))
          }
          return text(blocks.join('\n\n'))
        },
        presentationMeta: (_args, v) => clean({
          days: v.days?.map(d => d.day) ?? [],
          error: v.error ?? undefined,
        }),
      },
      concurrencySafe: true,
      execute(args) {
        const days = nwuData.days
        const list = args.date ? [dayOf(args.date)].filter(Boolean) : days
        if (!list.length) {
          return clean({ error: `没有 ${args.date} 这一天`, days: [], availableDays: days.map(d => d.short) })
        }
        return clean({
          days: list.map(d => ({
            ref: d.dayNoteId || undefined,
            date: d.date, day: d.short, week: d.week,
            route: d.route || undefined, altRange: d.altRange || undefined,
            pointCount: d.points.length,
            summary: clip(d.summary, 200) || undefined,
            hasWeather: !!(d.wx && d.wx.rows.length),
            points: d.points.map(p => ({
              ref: p.id, n: p.n, title: p.title,
              time: p.time || undefined, alt: num(p.alt),
              venue: p.venue || undefined, center: clip(p.center, 120) || undefined,
            })),
            roadside: d.roadside.length
              ? d.roadside.map(r => `${r.time} ${r.spot}${r.alt && r.alt !== '—' ? ` (${r.alt}m)` : ''}：${clip(r.note, 80)}`)
              : undefined,
          })),
        })
      },
      presentResult(args, { content, meta }) {
        return {
          card: 'generic',
          title: meta?.error ? '行程' : `行程总览 · ${meta?.days?.join('/') ?? ''}`,
          content,
        }
      },
    },
  ]

  if (office || !fieldOnly) return tools.slice(0, 3)
  return tools
}
