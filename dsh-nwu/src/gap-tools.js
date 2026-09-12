// 知识缺口闭环工具。教务问答确认"已发布知识库未覆盖"后用 report_knowledge_gap
// 把问题落盘；知识维护模式用 list/resolve 把缺口当待办消化。
// 缺口走 events.jsonl 同一事实源，重启后可重放，不会丢。

const text = value => [{ type: 'text', text: value }]

const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'number' && !Number.isFinite(item)) continue
      out[key] = clean(item)
    }
    return out
  }
  return value
}

const fail = error => ({ error: error instanceof Error ? error.message : String(error) })

const gapSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    question: { type: 'string', required: true },
    notes: { type: 'array', items: { type: 'string' }, required: true },
    count: { type: 'number', required: true },
    status: { type: 'string', required: true },
    firstReportedAt: { type: 'string', required: true },
    lastReportedAt: { type: 'string', required: true },
    resolution: { type: 'string' },
    draftId: { type: 'string' },
    resolvedAt: { type: 'string' },
  },
}

const gapLine = (gap, index) =>
  `${index + 1}. ${gap.id}｜被问 ${gap.count} 次｜${gap.question}` +
  (gap.notes.length ? `\n   线索：${gap.notes.join('；')}` : '') +
  (gap.status === 'resolved' ? `\n   已解决：${gap.resolution || ''}` : '')

/** 仅供"教务问答" preset 注册：把答不上来的问题登记为知识缺口。 */
export function buildGapReportToolDefs(nwuData) {
  const store = nwuData.knowledge
  return [
    {
      name: 'report_knowledge_gap',
      description:
        '把一条已确认"已发布教务知识库未覆盖"的问题登记为知识缺口，供整理者在知识维护模式补充资料。' +
        '只有当你已经用 retrieve 等工具检索过且换过说法仍无可靠依据时才调用；question 用用户的原始问法。' +
        '同一问题重复登记只会累计次数，不会产生重复条目。',
      parameters: {
        question: { type: 'string', required: true, description: '用户的原始问题，保留原话' },
        note: { type: 'string', description: '补充线索：用户年级/学期、已检索过的关键词、最接近的已知条目等' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { gap: gapSchema, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `登记缺口失败：${value.error}`
          : `已登记知识缺口 ${value.gap.id}（这个问题累计被问 ${value.gap.count} 次）。整理者会在知识维护模式看到待补清单。`),
      },
      concurrencySafe: false,
      execute(args) {
        try { return clean({ gap: store.reportGap({ question: args.question, note: args.note }) }) }
        catch (error) { return fail(error) }
      },
      presentCall: () => ({ card: 'generic', title: '登记知识缺口' }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识缺口', content }),
    },
  ]
}

/** 仅供"知识维护" preset 注册：查看与销掉知识缺口待办。 */
export function buildGapManageToolDefs(nwuData) {
  const store = nwuData.knowledge
  return [
    {
      name: 'list_knowledge_gaps',
      description:
        '列出教务问答登记的知识缺口（知识库答不上来的问题），按未解决优先、被问次数排序。' +
        '整理新资料前先看这份清单，优先补大家反复在问的内容。',
      parameters: {
        status: { type: 'string', description: 'open（默认，未解决）、resolved 或 all' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            gaps: { type: 'array', items: gapSchema, required: true },
            count: { type: 'number', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.error) return text(`列出缺口失败：${value.error}`)
          if (!value.gaps.length) return text('目前没有待补的知识缺口。')
          return text([`共有 ${value.count} 条知识缺口：`, ...value.gaps.map(gapLine)].join('\n'))
        },
      },
      concurrencySafe: true,
      execute(args) {
        try {
          const status = args.status || 'open'
          if (!['open', 'resolved', 'all'].includes(status)) throw new Error('status 只能是 open、resolved 或 all')
          const gaps = store.listGaps(status === 'all' ? undefined : status).map(clean)
          return { gaps, count: gaps.length }
        } catch (error) { return fail(error) }
      },
      presentCall: () => ({ card: 'generic', title: '查看知识缺口待办' }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识缺口待办', content }),
    },
    {
      name: 'resolve_knowledge_gap',
      description:
        '把一条知识缺口标记为已解决。只有相关知识已经发布（或与用户确认不需要补充）后才调用，' +
        'resolution 必须说明是哪份已发布草稿覆盖了它，或为何不补。',
      parameters: {
        gapId: { type: 'string', required: true, description: '缺口编号，来自 list_knowledge_gaps' },
        resolution: { type: 'string', required: true, description: '解决说明，例如"已由 draft-xxxxxxxx 发布的《缓考申请流程》条目覆盖"' },
        draftId: { type: 'string', description: '覆盖此缺口的已发布草稿编号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { gap: gapSchema, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `处理缺口失败：${value.error}`
          : `缺口 ${value.gap.id} 已标记解决：${value.gap.resolution}`),
      },
      concurrencySafe: false,
      execute(args) {
        try { return clean({ gap: store.resolveGap(args.gapId, args.resolution, args.draftId) }) }
        catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `解决缺口 ${args.gapId}` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识缺口', content }),
    },
  ]
}
