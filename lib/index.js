// dsh-chat-recast — 改问 / 换答（Host 半）
//
// DSH 的聊天记录是只追加的：界面上永远改不掉已发出去的那句话（官方 Web 端只渲染
// 追加事件）。所以这里不做日志改写，而是用官方原语复刻 App 版的效果：
//
//   1. 找到这条回答对应的那条提问；
//   2. 在提问之前分叉（sessions.fork / sessionController.fork）——分叉出来的会话带
//      自己的 Agent，历史截止到提问前一刻；
//   3. 在分叉会话里用（修改后的）文字重新提问；
//   4. 把原标题去掉数字后缀，命名给新会话；
//   5. 把原会话移出列表（归档，不是从磁盘抹掉，可恢复）。
//
// 每一步都走公开服务，不做 surface 替换、不碰日志文件。
import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-chat-recast'
export const inject = ['sessions', 'agents', 'sessionController', 'sessionTitle', 'workspaceRegistry']

const ROUTE = '/dsh-chat-recast/api'
const MAX_TEXT_CHARS = 20000

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function historyPath() {
  return join(dshHome(), 'chat-recast', 'history.jsonl')
}

/** 只去掉"重复标题"式的后缀：(2) （2） - 2 / 尾部数字。保留正文里的数字。 */
function cleanTitle(title) {
  let next = String(title || '').trim()
  if (next === '') return ''
  next = next.replace(/\s*[(（]\d{1,3}[)）]\s*$/u, '')
  next = next.replace(/\s+-\s*\d{1,3}\s*$/u, '')
  next = next.replace(/\s+\d{1,3}\s*$/u, '')
  return next.trim()
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function eventsOf(session) {
  return session.snapshotEvents()
}

function findAssistantSeq(events, messageId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const id = event.data && event.data.message ? event.data.message.id : undefined
    if (id === messageId) return event.seq
  }
  return undefined
}

/** 最近一条"人类发出的"追加提问（跳过运行时上下文、重试占位）。 */
function findUserBefore(events, beforeSeq) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
    if (event.type !== 'user/message') continue
    if (event.surfaceOp !== 'append') continue
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') continue
    return event
  }
  return undefined
}

/** 按消息 id 找一条人类提问（用于用户消息行上的铅笔按钮）。 */
function findUserByMessage(events, messageId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message') continue
    if (event.surfaceOp !== 'append') continue
    const data = event.data
    if (!data || data.id !== messageId) continue
    const source = data.source
    if (!source || source.kind !== 'user') continue
    return event
  }
  return undefined
}

function summarizeQuestion(event) {
  const text = textOfContent(event.data && event.data.content)
  return {
    text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    truncated: text.length > MAX_TEXT_CHARS,
    messageId: String(event.data.id),
    seq: event.seq,
  }
}

function readBody(req, limit = 1000000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch { /* 已销毁 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, payload) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // 响应已发出
  }
}

function newRequestId() {
  return 'recast-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

async function recordHistory(entry) {
  try {
    await mkdir(join(dshHome(), 'chat-recast'), { recursive: true })
    await appendFile(historyPath(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch {
    // 记录失败不影响主流程
  }
}

function createRecast(ctx) {
  function sessionOf(sessionId) {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      const error = new Error('这个会话不在内存里：先打开它，再点动作')
      error.code = 'session-not-open'
      throw error
    }
    return session
  }

  function questionFor(sessionId, messageId) {
    const session = sessionOf(sessionId)
    const events = eventsOf(session)
    const anchor = messageId === undefined || messageId === ''
      ? findUserBefore(events)
      : (findUserByMessage(events, messageId) ?? (() => {
        const seq = findAssistantSeq(events, messageId)
        if (seq === undefined) {
          const error = new Error('在当前会话里找不到这条消息')
          error.code = 'answer-not-found'
          throw error
        }
        return findUserBefore(events, seq)
      })())
    if (anchor === undefined) {
      const error = new Error('这条回答前面没有可改的提问')
      error.code = 'question-not-found'
      throw error
    }
    const title = ctx.sessionTitle.get(session)
    return {
      session,
      question: summarizeQuestion(anchor),
      title: title === undefined ? '' : title.title,
      cleanTitle: title === undefined ? '' : cleanTitle(title.title),
    }
  }

  /** 分叉 → 重问 → 改名 → 归档原会话。 */
  async function recast({ sessionId, messageId, text, action }) {
    const session = sessionOf(sessionId)
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      const error = new Error('这个会话正在回答，等这一轮结束再操作')
      error.code = 'session-busy'
      throw error
    }
    const found = questionFor(sessionId, messageId)
    const promptText = typeof text === 'string' && text.trim() !== '' ? text : found.question.text
    if (promptText.trim() === '') {
      const error = new Error('这条提问没有文字内容（可能只有附件），暂时不能改')
      error.code = 'question-empty'
      throw error
    }
    if (promptText.length > MAX_TEXT_CHARS) {
      const error = new Error(`提问超过 ${MAX_TEXT_CHARS} 字符上限`)
      error.code = 'question-too-long'
      throw error
    }

    const boundary = found.question.seq - 1
    if (boundary < 0) {
      const error = new Error('这条提问在对话最开头，前面没有可分叉的位置')
      error.code = 'no-boundary'
      throw error
    }

    const forked = await ctx.sessionController.fork({ sessionId, atSeq: boundary })
    const childId = forked.sessionId
    const requestId = newRequestId()
    const admission = new AbortController()
    await ctx.sessionController.prompt(
      { requestId, sessionId: childId, mode: 'queue', content: [{ type: 'text', text: promptText }] },
      admission.signal,
    )

    // 分叉会继承父会话标题事件；这里再显式钉住，并去掉重复标题的数字后缀。
    let title = found.cleanTitle
    const child = ctx.sessions.get(childId)
    if (child !== undefined && title !== '') {
      try {
        ctx.sessionTitle.rename(child, title)
      } catch {
        title = found.cleanTitle
      }
    }

    let archived = false
    let archiveError = null
    try {
      // 注册表是归档的真相源（会话已知性检查 + durable 写入都在这里）；
      // controller 只是它的 Remote 门面，直接调注册表能拿到真实持久化。
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      archived = true
    } catch (error) {
      archiveError = error && error.message ? error.message : String(error)
    }

    await recordHistory({
      action,
      sourceSessionId: sessionId,
      childSessionId: childId,
      title,
      archived,
      promptChars: promptText.length,
      questionSeq: found.question.seq,
      boundary,
    })

    return {
      childSessionId: childId,
      title,
      archived,
      archiveError,
      sourceSessionId: sessionId,
      promptChars: promptText.length,
    }
  }

  return { questionFor, recast }
}

async function handleHttp(studio, req, res) {
  try {
    const url = new URL(req.url || '/', 'http://local')
    if (req.method === 'GET' || req.method === 'HEAD') {
      const sessionId = url.searchParams.get('sessionId') || ''
      const messageId = url.searchParams.get('messageId') || ''
      if (sessionId === '') {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        return
      }
      const found = studio.questionFor(sessionId, messageId)
      sendJson(res, 200, {
        ok: true,
        question: found.question,
        title: found.title,
        cleanTitle: found.cleanTitle,
        canEdit: found.question.seq > 0,
      })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '仅支持 GET / POST' })
      return
    }
    let patch
    try {
      patch = JSON.parse((await readBody(req)) || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const action = String(patch.action || '')
    if (action === 'log') {
      try {
        await mkdir(join(dshHome(), 'chat-recast'), { recursive: true })
        await appendFile(
          join(dshHome(), 'chat-recast', 'client-errors.log'),
          new Date().toISOString() + ' ' + String(patch.message || '') + '\n',
          'utf8',
        )
      } catch {
        // 诊断写入失败不影响主流程
      }
      sendJson(res, 200, { ok: true })
      return
    }
    if (action !== 'edit' && action !== 'recast') {
      sendJson(res, 400, { ok: false, error: '未知 action：' + action })
      return
    }
    if (typeof patch.sessionId !== 'string' || patch.sessionId === '') {
      sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
      return
    }
    const result = await studio.recast({
      sessionId: patch.sessionId,
      messageId: typeof patch.messageId === 'string' ? patch.messageId : undefined,
      text: typeof patch.text === 'string' ? patch.text : undefined,
      action,
    })
    sendJson(res, 200, { ok: true, result })
  } catch (error) {
    const code = error && error.code === 'session-busy' ? 409 : 400
    sendJson(res, code, { ok: false, error: error && error.message ? error.message : String(error) })
  }
}

export function apply(ctx) {
  const studio = createRecast(ctx)

  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (req, res) => handleHttp(studio, req, res),
        }),
      'dsh-chat-recast: 动作接口',
    )
  })

  console.log('dsh-chat-recast: 已激活（改问 / 换答）')
}
