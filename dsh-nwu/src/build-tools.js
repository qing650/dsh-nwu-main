const text = value => [{ type: 'text', text: value }]
const clip = (value, limit = 240) => {
  const string = String(value || '')
  return string.length > limit ? `${string.slice(0, limit)}…` : string
}

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

const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    size: { type: 'number', required: true },
    textChars: { type: 'number', required: true },
    createdAt: { type: 'string', required: true },
  },
}

const draftNodeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    content: { type: 'string', required: true },
    relations: { type: 'array', items: { type: 'string' }, required: true },
    coordinate: { type: 'array', items: { type: 'number' } },
    date: { type: 'string' },
    time: { type: 'string' },
    altitude: { type: 'number' },
  },
}

const draftSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    status: { type: 'string', required: true },
    sourceIds: { type: 'array', items: { type: 'string' }, required: true },
    nodeCount: { type: 'number', required: true },
    nodes: { type: 'array', items: draftNodeSchema, required: true },
    confirmation: { type: 'string' },
    createdAt: { type: 'string', required: true },
    publishedAt: { type: 'string' },
  },
}

function sourceView(source) {
  return clean({
    id: source.id,
    name: source.name,
    kind: source.kind,
    mediaType: source.mediaType,
    size: source.size,
    textChars: source.textChars,
    createdAt: source.createdAt,
  })
}

function draftView(draft, includeNodes = true) {
  return clean({
    id: draft.id,
    title: draft.title,
    summary: draft.summary || '',
    status: draft.status,
    sourceIds: draft.sourceIds,
    nodeCount: draft.nodes.length,
    nodes: includeNodes ? draft.nodes.map(node => ({
      id: node.id,
      title: node.t,
      kind: node.k,
      content: node.content,
      relations: node.relations || [],
      coordinate: node.c,
      date: node.date,
      time: node.time,
      altitude: node.alt,
    })) : [],
    confirmation: draft.confirmation,
    createdAt: draft.createdAt,
    publishedAt: draft.publishedAt,
  })
}

function fail(error) {
  return { error: error instanceof Error ? error.message : String(error) }
}

/** 仅供“知识维护” preset 注册的变更工具。 */
export function buildKnowledgeToolDefs(nwuData) {
  const store = nwuData.knowledge
  const kindHint = (nwuData.site?.kinds?.order || ['政策文件', '办事指南', '常见问题', '通知公告', '名词解释'])
    .filter(kind => kind !== '索引')
    .join('、')
  return [
    {
      name: 'capture_source_text',
      description: '把用户在对话中提供的原始文字、扫描件识读结果或会议纪要保存为不可变来源。先保存来源，再创建知识草稿。',
      parameters: {
        name: { type: 'string', required: true, description: '来源名称，如“2025版学籍管理规定”' },
        text: { type: 'string', required: true, description: '忠实保留的原始内容，不要在这里总结或改写' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { source: sourceSchema, duplicate: { type: 'boolean' }, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `保存来源失败：${value.error}`
          : `已保存来源「${value.source.name}」\n编号：${value.source.id}\n可提取文字：${value.source.textChars} 字${value.duplicate ? '\n（与已有来源内容相同，已去重）' : ''}`),
      },
      concurrencySafe: false,
      execute(args) {
        try {
          const result = store.importText({ name: args.name, text: args.text, metadata: { channel: 'conversation' } })
          return { source: sourceView(result.source), duplicate: result.duplicate }
        } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `保存来源「${args.name}」` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '资料来源', content }),
    },
    {
      name: 'list_sources',
      description: '列出知识维护资料夹和当前对话已经保存的来源。用户说“处理最新资料”时先调用。',
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            sources: { type: 'array', items: sourceSchema, required: true },
            count: { type: 'number', required: true },
          },
        },
        render: (_args, value) => text(value.sources.length
          ? [`共有 ${value.count} 份来源：`, ...value.sources.map(x => `- ${x.id}｜${x.name}｜${x.kind}｜${x.textChars} 字`)].join('\n')
          : '尚未收录资料。请切换到“知识维护”并选择资料总文件夹，或直接在对话中粘贴文字。'),
      },
      concurrencySafe: true,
      execute() {
        const sources = store.listSources().map(sourceView)
        return { sources, count: sources.length }
      },
      presentCall: () => ({ card: 'generic', title: '查看已收录资料' }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '资料来源', content }),
    },
    {
      name: 'read_source',
      description: '分段读取一份来源的提取文本。长资料按 nextOffset 继续读取，不能只看开头就创建草稿。',
      parameters: {
        sourceId: { type: 'string', required: true, description: '来源编号' },
        offset: { type: 'number', description: '起始字符位置，默认 0' },
        limit: { type: 'number', description: '本次读取字符数，默认 12000，最多 30000' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            source: sourceSchema,
            text: { type: 'string' },
            offset: { type: 'number' },
            nextOffset: { type: 'number' },
            totalChars: { type: 'number' },
            structuredPreview: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => text(value.error
          ? `读取来源失败：${value.error}`
          : `来源：${value.source.name}（${value.source.id}）\n字符：${value.offset}—${value.offset + value.text.length} / ${value.totalChars}${value.nextOffset == null ? '，已读完' : `，下一段 offset=${value.nextOffset}`}\n\n${value.text}${value.structuredPreview ? `\n\n【结构化数据预览】\n${value.structuredPreview}` : ''}`),
      },
      concurrencySafe: true,
      execute(args) {
        try {
          const result = store.readSource(args.sourceId, args.offset, args.limit)
          return clean({ ...result, source: sourceView(result.source) })
        } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `读取来源 ${args.sourceId}` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '来源内容', content }),
    },
    {
      name: 'create_knowledge_draft',
      description: '根据已经完整读取的来源创建待审核知识图谱草稿。只创建草稿，不会进入正式图谱。每个事实必须能由 sourceIds 中的资料支持。',
      parameters: {
        title: { type: 'string', required: true, description: '本批草稿名称' },
        summary: { type: 'string', required: true, description: '本批资料覆盖范围和提取说明' },
        sourceIds: { type: 'array', items: { type: 'string' }, required: true, description: '本草稿所依据的来源编号' },
        nodes: {
          type: 'array', required: true, description: '准备写入图谱的知识节点，1—100 个',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              kind: { type: 'string', required: true, description: kindHint },
              content: { type: 'string', required: true, description: '有信息密度的事实正文，至少 20 字，不得加入来源外知识' },
              relations: { type: 'array', items: { type: 'string' }, description: '相关节点标题' },
              coordinate: { type: 'array', items: { type: 'number' }, description: '[经度, 纬度]' },
              date: { type: 'string' },
              time: { type: 'string' },
              altitude: { type: 'number' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { draft: draftSchema, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `创建草稿失败：${value.error}`
          : [`已创建草稿「${value.draft.title}」（${value.draft.id}）`, `共 ${value.draft.nodeCount} 个节点，尚未进入正式知识图谱。`, ...value.draft.nodes.map(x => `- ${x.kind}《${x.title}》：${clip(x.content)}`), `\n请用户检查后明确发送：${value.draft.confirmation}`].join('\n')),
      },
      concurrencySafe: false,
      execute(args) {
        try { return { draft: draftView(store.createDraft(args)) } } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `生成知识草稿「${args.title}」` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识图谱草稿', content }),
    },
    {
      name: 'list_knowledge_drafts',
      description: '列出知识草稿，可按 pending、published、rejected 状态筛选。',
      parameters: { status: { type: 'string', description: 'pending、published 或 rejected' } },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { drafts: { type: 'array', items: draftSchema, required: true }, count: { type: 'number', required: true }, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `列出草稿失败：${value.error}`
          : value.drafts.length
            ? [`共有 ${value.count} 份草稿：`, ...value.drafts.map(x => `- ${x.id}｜${x.status}｜${x.title}｜${x.nodeCount} 个节点`)].join('\n')
            : '没有符合条件的草稿。'),
      },
      concurrencySafe: true,
      execute(args) {
        try {
          if (args.status && !['pending', 'published', 'rejected'].includes(args.status)) throw new Error('status 只能是 pending、published 或 rejected')
          const drafts = store.listDrafts(args.status).map(x => draftView(x, false))
          return { drafts, count: drafts.length }
        } catch (error) { return fail(error) }
      },
      presentCall: () => ({ card: 'generic', title: '查看知识草稿' }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识草稿', content }),
    },
    {
      name: 'review_knowledge_draft',
      description: '读取一份草稿的完整节点、关系、坐标和来源，供用户审核。发布前必须调用并把内容展示给用户。',
      parameters: { draftId: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { draft: draftSchema, error: { type: 'string' } } },
        render: (_args, value) => text(value.error
          ? `读取草稿失败：${value.error}`
          : [`草稿「${value.draft.title}」（${value.draft.id}）`, `状态：${value.draft.status}；来源：${value.draft.sourceIds.join('、')}`, ...value.draft.nodes.map((x, i) => `${i + 1}. ${x.kind}《${x.title}》\n${x.content}\n关联：${x.relations.join('、') || '无'}${x.coordinate ? `\n坐标：${x.coordinate.join(', ')}` : ''}`), value.draft.confirmation ? `\n确认无误后，请明确发送：${value.draft.confirmation}` : ''].filter(Boolean).join('\n\n')),
      },
      concurrencySafe: true,
      execute(args) {
        try { return { draft: draftView(store.getDraft(args.draftId)) } } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `审核草稿 ${args.draftId}` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '草稿审核', content }),
    },
    {
      name: 'publish_knowledge_draft',
      description: '把已审核草稿发布到正式知识图谱并立即热更新问答检索。只有用户刚刚原样发送确认口令时才可调用。',
      parameters: {
        draftId: { type: 'string', required: true },
        confirmation: { type: 'string', required: true, description: '必须原样传入用户发送的“确认发布 draft-xxxxxxxx”' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { draftId: { type: 'string' }, revision: { type: 'number' }, publishedNodes: { type: 'number' }, graphNodes: { type: 'number' }, error: { type: 'string' } },
        },
        render: (_args, value) => text(value.error
          ? `发布失败：${value.error}`
          : `发布完成：${value.draftId} 已成为第 ${value.revision} 个知识版本，新增或更新 ${value.publishedNodes} 个节点。正式图谱现有 ${value.graphNodes} 个节点，教务问答已可检索。`),
      },
      concurrencySafe: false,
      execute(args) {
        try {
          const result = nwuData.publishDraft(args.draftId, args.confirmation)
          return { draftId: args.draftId, revision: result.revision, publishedNodes: result.nodes.length, graphNodes: nwuData.engine.stats.nodes }
        } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `发布草稿 ${args.draftId}` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '知识图谱发布', content }),
    },
    {
      name: 'reject_knowledge_draft',
      description: '用户明确要求放弃草稿时将其驳回，保留审计记录但不会进入正式图谱。',
      parameters: {
        draftId: { type: 'string', required: true },
        reason: { type: 'string', required: true, description: '用户给出的驳回或重做原因' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { draftId: { type: 'string' }, status: { type: 'string' }, error: { type: 'string' } } },
        render: (_args, value) => text(value.error ? `驳回失败：${value.error}` : `草稿 ${value.draftId} 已驳回，未写入正式知识图谱。`),
      },
      concurrencySafe: false,
      execute(args) {
        try {
          const draft = store.rejectDraft(args.draftId, args.reason)
          return { draftId: draft.id, status: draft.status }
        } catch (error) { return fail(error) }
      },
      presentCall: args => ({ card: 'generic', title: `驳回草稿 ${args.draftId}` }),
      presentResult: (_args, { content }) => ({ card: 'generic', title: '草稿已驳回', content }),
    },
  ]
}
