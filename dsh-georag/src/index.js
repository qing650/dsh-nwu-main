// dsh-georag · SQLite 图数据库 + 图谱增强检索引擎与数据服务
//
// 基础知识由 data/*.json 导入 data/nwu.sqlite 的 graph_nodes / graph_edges；
// 运行期增量写入同一个 SQLite；启动时从数据库重放后构建三路检索
// （词法 BM25 中文二元组 + 知识图谱双链扩展 + 可选空间距离衰减）。
// engine.js 为纯 ESM 零依赖实现（与独立 Web 前端共用同一份），此处原样复用，
// 因此 tools/eval_qa.mjs 评测可以直接 import 本包的 engine 做回归。
import fs from 'node:fs'
import path from 'node:path'
import z from '../../deepseek-harness-master/deepseek-harness-master/vendor/schemastery/lib/index.mjs'
import { createEngine } from './engine.js'
import { createHashEmbedder } from './embedding.js'
import { KnowledgeStore } from './knowledge-store.js'

export const name = 'georag'
export const inject = []

export const Config = z.object({
  /**
   * 数据目录：build_data.py 的输出目录，
   * 含 site_data / graph_data / days_data / map_data / photos_index.json。
   */
  dataDir: z.string().default(() => path.join(process.cwd(), 'data')),
})

const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? path.join(process.cwd(), 'data')
  const knowledge = new KnowledgeStore(dataDir)
  const service = { dataDir, knowledge, dbPath: knowledge.dbPath }
  const embedder = createHashEmbedder({ dim: 768 })

  function load() {
    const site = readJson(dataDir, 'site_data.json')
    const graph = readJson(dataDir, 'graph_data.json')
    const days = readJson(dataDir, 'days_data.json')
    const map = readJson(dataDir, 'map_data.json')
    const photos = readJson(dataDir, 'photos_index.json')
    knowledge.importBaseGraph(graph.nodes)
    const graphNodes = knowledge.graphNodes()
    knowledge.saveNodeEmbeddings(
      graphNodes.map(node => ({ id: node.id, vector: embedder.embed(node.md || node.t || '') })),
    )
    const embeddings = knowledge.loadNodeEmbeddings()
    const publishedNodes = knowledge.publishedNodes()
    const mergedGraph = { ...graph, nodes: graphNodes }
    const engine = createEngine({
      nodes: mergedGraph.nodes,
      days,
      mapLayers: map.layers,
      embeddings,
      embedText: embedder.embed,
    })
    Object.assign(service, {
      site,
      graph: mergedGraph,
      baseGraph: graph,
      days,
      map,
      photos,
      engine,
      embedder,
      graphStats: knowledge.graphStats(),
      stats: engine.stats,
    })
    ctx.logger('georag').info(
      `${site.name}：SQLite ${knowledge.graphStats().nodes} 节点 / ${knowledge.graphStats().edges} 条边 / ` +
      `${publishedNodes.length} 运行期发布节点 / ${engine.stats.chunks} 知识块`,
    )
    return service
  }

  service.reload = load
  service.publishDraft = (id, confirmation) => {
    const result = knowledge.publishDraft(id, confirmation)
    load()
    return result
  }

  // 对外始终暴露同一个可变服务对象，热重载后既有 preset 立即看到新引擎。
  load()
  service.close = () => knowledge.close()
  ctx.provide('nwuData', service)
}
