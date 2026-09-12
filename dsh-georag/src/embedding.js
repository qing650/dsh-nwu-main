// 本地可复现的向量嵌入：中文二元组 + 三元字特征哈希到定长向量。
// 无需下载模型，可在 SQLite 中持久化，适合与 BM25/图谱做组合检索；
// 如需更强的语义向量，可在此文件外接入 OpenAI/本地 Embedding API。
import { tokenize } from './engine.js'

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function ngrams(text, n) {
  const out = []
  for (let i = 0; i + n <= text.length; i++) out.push(text.slice(i, i + n))
  return out
}

/**
 * @param {object} options { dim=768, salt='nwu', version=1 }
 * @returns {{ name:string, dim:number, embed(text:string):Float32Array }}
 */
export function createHashEmbedder({ dim = 768, salt = 'nwu-rag', version = 1 } = {}) {
  const prefix = `${salt}:v${version}:`

  function embed(text) {
    const vec = new Float32Array(dim)
    const clean = String(text ?? '')
      .toLowerCase()
      .replace(/\{\{photo:[^}]+\}\}/g, '')
      .replace(/\[\[([^\]]+?)\]\]/g, (_, inner) => inner.replace(/\\\|/g, '|').split('|')[0].split('#')[0].trim())
      .replace(/[*_`#>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!clean) return vec

    const features = new Set(tokenize(clean))
    // 汉字连续段补充三元组特征，避免纯二元组把“成绩更正”和“更正成绩”判为相同方向。
    for (const m of clean.matchAll(/[一-鿿]{3,}/g)) {
      for (const gram of ngrams(m[0], 3)) features.add(`#${gram}`)
    }
    // 保留全文本身作为长片段特征，轻微提升同主题但措辞不同的条目。
    if (clean.length > 8) features.add(`$whole:${clean.length}`)

    for (const feature of features) {
      const h = fnv1a(prefix + feature)
      const idx = h % dim
      vec[idx] += (h >>> 16) & 1 ? 1 : -1
    }

    let norm = 0
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm
    return vec
  }

  return { name: 'local-hash-embedding', dim, embed }
}
