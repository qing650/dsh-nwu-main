// 后端客户端。浏览器不再持有任何 API Key——密钥只存在于服务端环境变量。
// 开发期由 vite proxy 把 /api、/photos 转到后端；生产由后端直接托管 dist，同源。
const BASE = import.meta.env.VITE_API_BASE || ''

export const photoUrl = (pid) => `${BASE}/photos/${encodeURIComponent(pid)}.jpg`

async function getJson(p) {
  const r = await fetch(BASE + p)
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`)
  return r.json()
}

/** 启动时一次性拉齐渲染地图/图谱/日志所需的数据（照片走静态 URL，不进这里） */
export async function loadAll() {
  const [site, graph, days, map, photos] = await Promise.all([
    getJson('/api/site'),
    getJson('/api/data/graph'),
    getJson('/api/data/days'),
    getJson('/api/data/map'),
    getJson('/api/data/photos'),
  ])
  return { site, graph, days, map, photos }
}

export const health = () => getJson('/api/health')

/** 无模型时的纯检索（服务端引擎），返回与 /api/chat 的 retrieval 事件同构 */
export async function search(question, coord) {
  const r = await fetch(BASE + '/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, coord }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * SSE 流式问答。EventSource 不支持 POST，所以手工解析 fetch 的流。
 * 事件：retrieval / tool / tool_result / text / refs / error / done
 * @returns {Promise<{mode:string}>}
 */
export async function chat({ question, history = [], coord = null, on = {}, signal }) {
  const resp = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history, coord }),
    signal,
  })
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`
    try { msg = (await resp.json()).error || msg } catch { /* ignore */ }
    throw new Error(msg)
  }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let done = { mode: 'offline' }

  for (;;) {
    const { done: fin, value } = await reader.read()
    if (fin) break
    buf += dec.decode(value, { stream: true })
    // SSE 以空行分隔事件块
    const blocks = buf.split('\n\n')
    buf = blocks.pop()
    for (const block of blocks) {
      let event = 'message'
      const payload = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue                 // 心跳
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) payload.push(line.slice(5).trim())
      }
      if (!payload.length) continue
      let data
      try { data = JSON.parse(payload.join('\n')) } catch { continue }
      if (event === 'done') done = data
      on[event]?.(data)
    }
  }
  return done
}
