import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '../deepseek-harness-master/deepseek-harness-master/vendor/cordis/lib/index.js'
import SystemPrompt from '../deepseek-harness-master/deepseek-harness-master/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../deepseek-harness-master/deepseek-harness-master/packages/core/tools/lib/index.js'
import { CallId } from '../deepseek-harness-master/deepseek-harness-master/packages/llm/llm/lib/index.js'
import { buildPhotoMapData } from '../dsh-nwu-intake/src/index.js'
import * as georag from '../dsh-georag/src/index.js'
import * as nwu from './src/index.js'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nwu-product-test-'))
for (const file of ['site_data.json', 'graph_data.json', 'days_data.json', 'map_data.json', 'photos_index.json']) {
  fs.copyFileSync(path.resolve('../data', file), path.join(fixture, file))
}

let counter = 0
const execute = (ctx, name, args) => ctx.tools.execute({
  signal: new AbortController().signal,
  callId: CallId(`product-${++counter}`),
  name,
  arguments: args,
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function context(mode) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(georag, { dataDir: fixture })
  await ctx.plugin(nwu, { mode })
  return ctx
}

try {
  const build = await context('build')
  const buildNames = build.tools.schemas().map(schema => schema.name)
  assert(buildNames.includes('publish_knowledge_draft'), '建库模式缺少发布工具')
  assert(buildNames.includes('retrieve'), '建库模式缺少查重检索工具')

  const captured = await execute(build, 'capture_source_text', {
    name: '教务链路测试记录',
    text: '示例通知称重修需学生网上报名、学院审核并分配教学班。已及格课程提高成绩须先申请成绩作废，作废后再报名重修。本记录仅用于产品链路测试。',
  })
  assert(!captured.isError && captured.value?.source?.id, '来源保存失败')
  const sourceId = captured.value.source.id

  const created = await execute(build, 'create_knowledge_draft', {
    title: '教务链路测试草稿',
    summary: '从示例通知提取一个办事指南和一个常见问答。',
    sourceIds: [sourceId],
    nodes: [
      {
        title: '重修报名示例',
        kind: '办事指南',
        content: '测试记录写明重修采用学生网上报名、学院审核并分配教学班的流程，是本批测试资料中的办事指南条目。',
        relations: ['成绩作废示例'],
      },
      {
        title: '成绩作废示例',
        kind: '常见问题',
        content: '测试记录写明已及格课程提高成绩不能直接重修，须先申请成绩作废，作废后再报名重修。',
        relations: ['重修报名示例'],
      },
    ],
  })
  assert(!created.isError && created.value?.draft?.id, '草稿创建失败')
  const draftId = created.value.draft.id

  const denied = await execute(build, 'publish_knowledge_draft', { draftId, confirmation: '可以发布' })
  assert(denied.value?.error?.includes('明确发送'), '非精确确认口令没有被拒绝')

  const published = await execute(build, 'publish_knowledge_draft', { draftId, confirmation: `确认发布 ${draftId}` })
  assert(!published.isError && published.value?.publishedNodes === 2, '草稿发布失败')
  assert(build.nwuData.engine.stats.nodes >= 22, '图谱发布后没有热更新')

  const hotSearch = await execute(build, 'retrieve', { query: '重修怎么报名' })
  assert(hotSearch.value?.hits?.some(hit => hit.title === '重修报名示例'), '发布后未能立即检索到新节点')
  build.nwuData.knowledge.close()
  await build.fiber.dispose()

  const qa = await context('qa')
  const qaNames = qa.tools.schemas().map(schema => schema.name)
  assert(qaNames.includes('retrieve'), '问答模式缺少检索工具')
  assert(!qaNames.includes('capture_source_text'), '问答模式泄露了来源写入工具')
  assert(!qaNames.includes('publish_knowledge_draft'), '问答模式泄露了发布工具')
  assert(qaNames.includes('report_knowledge_gap'), '问答模式缺少知识缺口登记工具')
  assert(!qaNames.includes('resolve_knowledge_gap'), '问答模式泄露了缺口处理工具')
  const replaySearch = await execute(qa, 'retrieve', { query: '重修报名示例' })
  assert(replaySearch.value?.hits?.some(hit => hit.title === '重修报名示例'), '重启重放后未检索到已发布节点')
  assert(qa.nwuData.knowledge.stats().events === 3, '事件日志数量不符合预期')

  // 知识缺口闭环：教务问答登记（重复问法去重累计）→ 知识维护查看并销掉
  const gapFirst = await execute(qa, 'report_knowledge_gap', {
    question: '重修能不能同时报两门？',
    note: '已检索"重修/报名门数"，无结果',
  })
  assert(!gapFirst.isError && gapFirst.value?.gap?.status === 'open', '缺口登记失败')
  const gapAgain = await execute(qa, 'report_knowledge_gap', { question: '重修能不能同时报两门' })
  assert(gapAgain.value?.gap?.id === gapFirst.value.gap.id, '同一问题的不同标点写法没有归并')
  assert(gapAgain.value?.gap?.count === 2, '重复上报没有累计次数')
  qa.nwuData.knowledge.close()
  await qa.fiber.dispose()

  const build2 = await context('build')
  const build2Names = build2.tools.schemas().map(schema => schema.name)
  assert(build2Names.includes('list_knowledge_gaps') && build2Names.includes('resolve_knowledge_gap'), '建库模式缺少缺口待办工具')
  assert(!build2Names.includes('report_knowledge_gap'), '建库模式不应有缺口登记工具')
  const gapList = await execute(build2, 'list_knowledge_gaps', {})
  assert(gapList.value?.count === 1 && gapList.value.gaps[0].count === 2, '重放后缺口待办不符合预期')
  const resolved = await execute(build2, 'resolve_knowledge_gap', {
    gapId: gapList.value.gaps[0].id,
    resolution: '测试：由教务链路草稿覆盖',
    draftId,
  })
  assert(!resolved.isError && resolved.value?.gap?.status === 'resolved', '缺口未能标记解决')
  const gapListAfter = await execute(build2, 'list_knowledge_gaps', {})
  assert(gapListAfter.value?.count === 0, '已解决缺口仍出现在待办里')
  assert(build2.nwuData.knowledge.stats().events === 6, '缺口事件没有落盘')

  // 教务站点不再挂载照片地图：兼容函数在空数据下应返回空统计
  const photoMap = buildPhotoMapData(build2.nwuData)
  assert(Array.isArray(photoMap.bounds) && photoMap.bounds.length === 4, '照片地图缺少范围')
  assert(photoMap.stats.days === 0 && photoMap.stats.points === 0 && photoMap.stats.photos === 0, '教务数据不应出现照片地图内容')
  assert(photoMap.days.length === 0, '教务数据不应有旧实习日')
  build2.nwuData.knowledge.close()
  await build2.fiber.dispose()

  console.log('产品链路测试通过：来源、草稿、确认门禁、发布热更新、事件重放、教务问答只读隔离、知识缺口闭环均正常')
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
