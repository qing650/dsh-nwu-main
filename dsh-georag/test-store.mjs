import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KnowledgeStore } from './src/knowledge-store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nwu-store-test-'))
try {
  const store = new KnowledgeStore(root)
  const buffer = Buffer.from('同一份原始资料')
  const failed = store.importSource({
    name: '录音.wav', buffer, kind: 'audio', text: '自动提取失败',
    metadata: { extractionError: '模型下载失败' },
  })
  const recovered = store.importSource({
    name: '录音.wav', buffer, kind: 'audio', text: '重新转写后的有效内容',
    metadata: { model: 'tiny' },
  })
  if (!recovered.reprocessed) throw new Error('失败来源没有进入重新提取分支')
  if (store.readSource(failed.source.id).text !== '重新转写后的有效内容') throw new Error('重新提取文本未生效')
  store.close()

  const replayed = new KnowledgeStore(root)
  if (replayed.readSource(failed.source.id).text !== '重新转写后的有效内容') throw new Error('重新提取事件重放失败')
  if (replayed.stats().events !== 2) throw new Error('重新提取事件数量不正确')
  replayed.close()
  console.log('知识存储测试通过：提取失败后可重试，重放结果一致')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
