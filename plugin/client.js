/**
 * cot-translate — DSH 动态插件 Client 半（右侧面板展示）。
 *
 * 本文件是 DSH「动态 Cordis 插件」的 Client 代码体（function body）：
 * 通过 cordis_define 提交、cordis_run 激活。使用 React.createElement
 * （无 JSX），注册到 shell.overlay 右侧空白处。
 *
 * 职责：
 *   1. 右侧固定窄面板（208px），不挡中间对话
 *   2. 顶部「开/关」+ 折叠 + 底部「↓ 回到底部」
 *   3. 译文按步骤彩色边框 + 「第N轮·步M」标注
 *   4. 自动向下滚动（用户上滚则暂停，回底恢复）
 *   5. 只显示当前会话的译文（用 useSessions 拿当前 sessionId）
 */
return {
  name: 'cot-translate-client',
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    function renderInline(text) {
      const s = String(text == null ? '' : text)
      const parts = s.split(/(`[^`]+`)/g)
      return parts.map((p, i) => {
        if (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`') {
          return React.createElement('code', { key: i, className: 'cotzh-code' }, p.slice(1, -1))
        }
        return p
      })
    }

    const STEP_COLORS = ['#58a6ff', '#7ee787', '#ffd166', '#ff7b9c']
    let flowEl = null

    function Panel(props) {
      const useSessions = props && props.useSessions
      const currentSessionId = useSessions ? useSessions((s) => (s ? s.current : undefined)) : undefined
      const [state, setState] = React.useState({ enabled: true, items: [], debug: null })
      const [open, setOpen] = React.useState(true)
      const [autoFollow, setAutoFollow] = React.useState(true)

      React.useEffect(() => {
        let disposed = false
        const poll = () => {
          host.call('get-state', { sessionId: currentSessionId }).then((s) => {
            if (disposed || !s) return
            setState({ enabled: !!s.enabled, items: s.items || [], debug: s.debug || null })
          }).catch(() => null)
        }
        poll()
        const stop = ctx.interval(poll, 800)
        return () => { disposed = true; stop() }
      }, [currentSessionId])

      React.useEffect(() => {
        if (autoFollow && flowEl) flowEl.scrollTop = flowEl.scrollHeight
      }, [state.items])

      const toggle = () => {
        const next = !state.enabled
        setState(Object.assign({}, state, { enabled: next }))
        host.call('toggle', { enabled: next }).catch(() => null)
      }
      const scrollToBottom = () => {
        setAutoFollow(true)
        if (flowEl) flowEl.scrollTop = flowEl.scrollHeight
      }
      const onScroll = () => {
        if (!flowEl) return
        const nearBottom = flowEl.scrollHeight - flowEl.scrollTop - flowEl.clientHeight < 30
        setAutoFollow(nearBottom)
      }

      const items = state.items
      const dbg = state.debug

      return React.createElement('div', { className: 'cotzh-root' },
        React.createElement('div', { className: 'cotzh-bar' },
          React.createElement('button', {
            className: 'cotzh-toggle' + (state.enabled ? ' on' : ''),
            onClick: toggle,
          }, state.enabled ? '开' : '关'),
          React.createElement('span', { className: 'cotzh-title' }, '思考人话'),
          React.createElement('button', { className: 'cotzh-mini', onClick: () => setOpen(!open) }, open ? '─' : '＋')
        ),
        open ? React.createElement('div', {
          className: 'cotzh-flow',
          ref: (el) => { flowEl = el },
          onScroll: onScroll,
        },
          items.length === 0
            ? React.createElement('div', { className: 'cotzh-empty' }, '等待英文思考…')
            : items.map((it) => {
                const color = STEP_COLORS[(it.step || 0) % 4]
                return React.createElement('div', { key: it.seq, className: 'cotzh-item', style: { borderLeftColor: color } },
                  React.createElement('div', { className: 'cotzh-meta' }, '第' + it.turn + '轮 · 步' + it.step),
                  React.createElement('div', { className: 'cotzh-zh' }, renderInline(it.zh))
                )
              })
        ) : null,
        open ? React.createElement('button', { className: 'cotzh-bottom', onClick: scrollToBottom }, '↓ 回到底部') : null,
        dbg ? React.createElement('div', { className: 'cotzh-debug' },
          '英' + dbg.capturedCount + ' · 中' + dbg.skippedZh + ' · ' + dbg.pendingChars + '字待译' + (dbg.lastError ? ' · ' + dbg.lastError : ''))
        : null
      )
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'cot-translate', order: 0 },
      (props) => React.createElement(Panel, { useSessions: props ? props.useSessions : undefined }),
    ))

    styles.insert(`
      .cotzh-root {
        position: fixed; right: 6px; top: 56px;
        z-index: 9000; pointer-events: auto; width: 208px;
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      .cotzh-bar {
        display: flex; align-items: center; gap: 6px;
        background: rgba(22,27,34,0.92); color: #e6edf3;
        border: 1px solid #30363d; border-radius: 8px; padding: 4px 8px;
        box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      .cotzh-toggle {
        border: 1px solid #30363d; background: transparent; color: inherit;
        border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer;
      }
      .cotzh-toggle.on { background: #1f6feb; color: #fff; border-color: transparent; }
      .cotzh-title { font-size: 12px; font-weight: 600; margin-right: auto; color: #8b949e; }
      .cotzh-mini { border: none; background: transparent; color: #8b949e; cursor: pointer; padding: 2px 6px; font-size: 12px; }
      .cotzh-mini:hover { color: #e6edf3; }
      .cotzh-flow { margin-top: 5px; max-height: 72vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
      .cotzh-item {
        background: rgba(22,27,34,0.92); border: 1px solid #30363d;
        border-left: 3px solid #30363d;
        border-radius: 8px; padding: 7px 9px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
      }
      .cotzh-meta { font-size: 10px; color: #8b949e; margin-bottom: 4px; }
      .cotzh-zh { font-size: 13px; line-height: 1.55; color: #e6edf3; white-space: pre-wrap; word-break: break-word; }
      .cotzh-code {
        font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
        font-size: 12px; color: #79c0ff; background: rgba(120,160,200,0.12);
        padding: 0 4px; border-radius: 4px; word-break: break-all;
      }
      .cotzh-empty { font-size: 12px; color: #484f58; padding: 3px 2px; }
      .cotzh-bottom {
        display: block; width: 100%; margin-top: 6px; padding: 7px;
        background: rgba(31,111,235,0.18); color: #79c0ff;
        border: 1px solid #30363d; border-radius: 8px; cursor: pointer; font-size: 12px;
      }
      .cotzh-bottom:hover { background: rgba(31,111,235,0.3); }
      .cotzh-debug { margin-top: 3px; font-size: 10px; color: #6e7681; text-align: right; }
    `)
  },
}
