/**
 * cot-translate — DSH 动态插件 Host 半（监听 & 调度）。
 *
 * 本文件是 DSH「动态 Cordis 插件」的 Host 代码体（function body）：
 * 通过 cordis_define 提交、cordis_run 激活。它不 import 任何东西，
 * 只通过 ctx.get() 访问 shell / timer 等服务。
 *
 * 职责：
 *   1. 纯监听 session/event（emit 事件，不碰 llm/stream 这条主模型流）
 *   2. 收集 assistant/chunk 的 reasoning-delta，按「大块」切段
 *   3. 只翻译英文思考（中文跳过），调本地 qwen-local 服务
 *   4. 译文按会话隔离、带轮次/步骤、写历史（E盘）
 */
return {
  name: 'cot-translate-host',
  inject: ['timer'],
  apply(ctx) {
    const shell = ctx.get('shell')
    if (shell === undefined) return

    let enabled = true
    const sessions = new Map()

    // 译文历史存储目录（JSONL）。按需修改；DSH 沙箱内无 process.env，
    // 故用常量而非环境变量。设成空字符串可关闭落盘。
    // 相对路径以 DSH 会话的工作区为基准。
    const HISTORY_DIR = './cache/cot-translate'

    function getSession(sid) {
      let s = sessions.get(sid)
      if (!s) {
        s = { seq: 0, items: [], pending: '', turn: 0, step: 0, queue: [], busy: false,
          debug: { capturedCount: 0, skippedZh: 0, pendingChars: 0, lastError: null } }
        sessions.set(sid, s)
      }
      return s
    }

    // 简易语言判断：英文思考才翻译，中文思考跳过。
    function isMostlyEnglish(text) {
      let ascii = 0, cjk = 0
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (c >= 0x4e00 && c <= 0x9fff) cjk++
        else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) ascii++
      }
      return ascii > 20 && ascii > cjk * 3
    }

    // 通过 shell 服务（本机为 PowerShell）发 HTTP 请求到本地翻译服务。
    function runPwsh(command, timeoutMs) {
      const spec = shell.resolve({ command, timeoutMs })
      return shell.run(spec)
    }

    async function fetchTranslate(text, s) {
      try {
        const body = JSON.stringify({ text })
        const b64 = btoa(body)
        const command = [
          "$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
          "$r = Invoke-WebRequest -Uri 'http://127.0.0.1:7860/v1/translate' -Method Post -Body $b -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 180",
          "$r.Content",
        ].join('\n')
        const result = await runPwsh(command, 180000)
        if (result.exitCode !== 0) {
          const se = result.stderr && result.stderr.text ? result.stderr.text.slice(0, 200) : ''
          s.debug.lastError = 'exit ' + result.exitCode + ' ' + se
          return null
        }
        const out = result.stdout && result.stdout.text ? result.stdout.text.trim() : ''
        const data = JSON.parse(out)
        if (data && data.ok) return data.text
        s.debug.lastError = 'bad resp: ' + out.slice(0, 200)
        return null
      } catch (e) {
        s.debug.lastError = String(e && e.message ? e.message : e).slice(0, 200)
        return null
      }
    }

    async function writeHistory(item) {
      if (!HISTORY_DIR) return
      try {
        const line = JSON.stringify({ t: Date.now(), sessionId: item.sessionId, turn: item.turn, step: item.step, zh: item.zh }) + '\n'
        const b64 = btoa(line)
        const command = [
          "New-Item -ItemType Directory -Force -Path '" + HISTORY_DIR + "' | Out-Null",
          "$v = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
          "Add-Content -Path '" + HISTORY_DIR + "/history.jsonl' -Value $v -NoNewline -Encoding UTF8",
        ].join('; ')
        await runPwsh(command, 10000)
      } catch (e) {}
    }

    function flushSegment(sid) {
      const s = getSession(sid)
      const text = s.pending.trim()
      s.pending = ''
      s.debug.pendingChars = 0
      if (!enabled) return
      if (text.length < 60) return
      if (!isMostlyEnglish(text)) { s.debug.skippedZh += 1; return }
      s.queue.push(text)
      s.debug.capturedCount += 1
      drain(sid).catch(() => null)
    }

    async function drain(sid) {
      const s = getSession(sid)
      if (s.busy) return
      if (s.queue.length === 0) return
      s.busy = true
      try {
        const text = s.queue.shift()
        try {
          const zh = await fetchTranslate(text, s)
          if (zh) {
            s.seq += 1
            const item = { seq: s.seq, sessionId: sid, turn: s.turn, step: s.step, zh }
            s.items.push(item)
            if (s.items.length > 100) s.items.splice(0, s.items.length - 100)
            await writeHistory(item)
          }
        } finally {
          s.busy = false
        }
      } catch (e) {
        s.busy = false
      }
      try {
        await ctx.timeout(300)
      } catch (e) {}
      drain(sid).catch(() => null)
    }

    ctx.on('session/event', (session, event) => {
      try {
        if (!event || !session) return
        const sid = session.id || session.sessionId
        if (!sid) return
        const s = getSession(sid)
        if (event.type === 'assistant/chunk') {
          const data = event.data
          if (!data) return
          if (typeof data.turn === 'number') s.turn = data.turn
          if (typeof data.step === 'number') s.step = data.step
          const chunk = data.chunk
          if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            s.pending += chunk.text
            s.debug.pendingChars = s.pending.length
            const LEN = s.pending.length
            const hasBreak = /[.!?。！？;；]\s*$/.test(s.pending)
            // 大块切段：约 200 词英文才输出，减少翻译次数、避免队列积压
            if ((hasBreak && LEN >= 800) || LEN >= 1500) flushSegment(sid)
          }
          return
        }
        if (event.type === 'assistant/message' || event.type === 'step/end' || event.type === 'turn/end') {
          if (s.pending.trim().length >= 60) flushSegment(sid)
          return
        }
      } catch (e) {}
    })

    harness.handle('get-state', (args) => {
      const sid = args && args.sessionId
      if (!sid) return { enabled, sessionId: null, items: [], debug: null }
      const s = getSession(sid)
      return { enabled, sessionId: sid, items: s.items.slice(-30), debug: s.debug }
    })
    harness.handle('toggle', (args) => {
      if (args && typeof args.enabled === 'boolean') enabled = args.enabled
      return { enabled }
    })
    harness.handle('clear', (args) => {
      const sid = args && args.sessionId
      if (sid) {
        const s = getSession(sid)
        s.items = []
        s.seq = 0
        s.pending = ''
        s.debug.capturedCount = 0
        s.debug.skippedZh = 0
        s.debug.pendingChars = 0
      }
      return { ok: true }
    })
  },
}
