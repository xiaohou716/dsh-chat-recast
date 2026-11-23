// dsh-chat-recast — 改问 / 换答（browser 半）
//
// 一个入口：回答动作行里的铅笔小按钮；鼠标悬停（或键盘聚焦）时向上浮出两项：
//   · 重新生成：同一个提问再问一次；
//   · 修改：改掉这条回答对应的提问后重问。
// 两项都由 Host 完成 fork → 重问 → 改名 → 归档原会话。
//
// 用户消息行不再由本插件接管，完全回到官方渲染。
window.__ModuleLoader__.load({
  id: 'dsh-chat-recast',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var ENDPOINT = '/dsh-chat-recast/api'

    function h(tag, props) {
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [tag, props].concat(children))
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(function () {
        var style = document.createElement('style')
        style.textContent =
          '.recast-wrap{display:inline-flex;align-items:center;gap:2px}' +
          '.recast-hit{display:inline-flex;align-items:center;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;padding:4px;height:calc(24px + var(--dsh-content-font-delta,0px))}' +
          '.recast-hit svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px));flex:none}' +
          '.recast-hit:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,inherit)}' +
          '.recast-hit:disabled{opacity:.4;cursor:default}' +
          '.recast-label{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;font-size:12px;transition:max-width .14s ease,opacity .14s ease,margin-left .14s ease;margin-left:0}' +
          '.recast-hit:hover .recast-label,.recast-hit:focus-visible .recast-label{max-width:140px;opacity:1;margin-left:5px}' +
          '.recast-inline{display:flex;flex-direction:column;gap:6px;width:min(560px,100%);margin-top:6px}' +
          '.recast-panel{position:fixed;z-index:60;display:flex;flex-direction:column;gap:8px;width:min(560px,calc(100vw - 24px));padding:10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-1,#1e1e1e);box-shadow:0 18px 52px rgba(0,0,0,.42)}' +
          '.recast-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:move;user-select:none;touch-action:none}' +
          '.recast-panel-title{font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}' +
          '.recast-panel-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,inherit);cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:2px 6px;border-radius:6px}' +
          '.recast-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}' +
          '.recast-area-floating{min-height:110px;resize:both;overflow:auto}' +
          '.recast-area{width:100%;min-height:76px;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);padding:7px 9px;font:inherit;font-size:12.5px;line-height:1.55}' +
          '.recast-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}' +
          '.recast-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
          '.recast-primary{border:0;border-radius:7px;background:#1677ff;color:#fff;font:inherit;font-size:12px;padding:4px 10px;cursor:pointer;transition:background .12s ease}' +
          '.recast-primary:hover:not(:disabled){background:#0b63d9}' +
          '.recast-primary:disabled{opacity:.5;cursor:default}' +
          '.recast-ghost{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 9px;cursor:pointer}' +
          '.recast-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit)}' +
          '.recast-err{font-size:11.5px;color:var(--dsw-alias-state-error-primary,#e5484d)}' +
          '.recast-ok{font-size:11.5px;color:var(--dsw-alias-state-success-primary,#30a46c)}'
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'dsh-chat-recast: 动作样式')

      function post(payload) {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (response) {
          return response.json().then(function (value) { return { status: response.status, value: value } })
        }).then(function (out) {
          if (!out.value || out.value.ok !== true) {
            throw new Error((out.value && out.value.error) || ('请求失败（HTTP ' + out.status + '）'))
          }
          return out.value.result
        })
      }

      function errorText(error) {
        return String(error && error.message ? error.message : error)
      }

      function recastLabel(result) {
        if (!result) return null
        var parts = []
        parts.push(result.title ? '已在新会话「' + result.title + '」重问' : '已在新会话重问')
        parts.push(result.archived ? '原对话已移出列表' : '原对话未移出')
        return parts.join('，')
      }

      /** 简略画风的铅笔。 */
      function PencilIcon(size) {
        return h('svg', {
          viewBox: '0 0 16 16', width: size || 14, height: size || 14, 'aria-hidden': 'true', focusable: 'false',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          h('path', { d: 'M2.6 13.4l1-3.4L10.4 3a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2L6 12.4z' }),
          h('path', { d: 'M10.4 3l2.6 2.6' }),
        )
      }

      /** 旋转箭头圆圈。 */
      function RefreshIcon() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
          h('path', { d: 'M13.4 8A5.4 5.4 0 1 1 11.6 3.9' }),
          h('path', { d: 'M13.4 2.4v3.2h-3.2' }),
        )
      }

      /**
       * 回答动作行里的入口：铅笔按钮 + 悬停浮出「重新生成 / 修改」。
       */
      function RecastEntry(props) {
        var busyState = React.useState(false)
        var busy = busyState[0], setBusy = busyState[1]
        var errState = React.useState(null)
        var error = errState[0], setError = errState[1]
        var noteState = React.useState(null)
        var note = noteState[0], setNote = noteState[1]
        var editingState = React.useState(false)
        var editing = editingState[0], setEditing = editingState[1]
        var draftState = React.useState('')
        var draft = draftState[0], setDraft = draftState[1]
        var loadingState = React.useState(false)
        var loading = loadingState[0], setLoading = loadingState[1]
        var posState = React.useState(null)
        var pos = posState[0], setPos = posState[1]
        var draggingState = React.useState(false)
        var dragging = draggingState[0], setDragging = draggingState[1]
        var dragRef = React.useRef(null)
        var btnRef = React.useRef(null)

        React.useEffect(function () {
          if (!dragging) return
          function move(event) {
            var origin = dragRef.current
            if (!origin) return
            var x = Math.min(Math.max(8, event.clientX - origin.dx), Math.max(8, window.innerWidth - 220))
            var y = Math.min(Math.max(8, event.clientY - origin.dy), Math.max(8, window.innerHeight - 90))
            setPos({ x: x, y: y })
          }
          function stop() {
            dragRef.current = null
            setDragging(false)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', stop)
          window.addEventListener('pointercancel', stop)
          return function () {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
          }
        }, [dragging])

        function startDrag(event) {
          if (event.button !== undefined && event.button !== 0) return
          var base = pos || { x: 24, y: 24 }
          if (!pos) setPos(base)
          dragRef.current = { dx: event.clientX - base.x, dy: event.clientY - base.y }
          setDragging(true)
          event.preventDefault()
        }

        function run(payload, onDone) {
          setBusy(true)
          setError(null)
          setNote(null)
          post(payload)
            .then(function (result) {
              setNote(recastLabel(result))
              if (onDone) onDone()
            })
            .catch(function (e) { setError(errorText(e)) })
            .then(function () { setBusy(false) })
        }

        function beginEdit() {
          setError(null)
          setNote(null)
          setLoading(true)
          var query = '?sessionId=' + encodeURIComponent(props.sessionId) + '&messageId=' + encodeURIComponent(props.messageId)
          fetch(ENDPOINT + query, { headers: { accept: 'application/json' } })
            .then(function (response) { return response.json() })
            .then(function (value) {
              if (!value || value.ok !== true) throw new Error((value && value.error) || '读取提问失败')
              setDraft(value.question.text)
              var rect = btnRef.current && typeof btnRef.current.getBoundingClientRect === 'function'
                ? btnRef.current.getBoundingClientRect()
                : null
              if (rect && rect.width + rect.height > 0) {
                setPos({
                  x: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 220)),
                  y: Math.min(Math.max(8, rect.bottom + 8), Math.max(8, window.innerHeight - 160)),
                })
              } else {
                setPos({ x: 24, y: 24 })
              }
              setEditing(true)
            })
            .catch(function (e) { setError(errorText(e)) })
            .then(function () { setLoading(false) })
        }

        var toolbar = h('div', { className: 'recast-wrap' },
          h('button', {
            type: 'button', className: 'recast-hit',
            title: '重新生成', 'aria-label': '重新生成',
            disabled: busy || editing,
            onClick: function () { run({ action: 'recast', sessionId: props.sessionId, messageId: props.messageId }) },
          }, RefreshIcon(), h('span', { className: 'recast-label' }, busy ? '重新生成中…' : '重新生成')),
          h('button', {
            type: 'button', className: 'recast-hit', ref: btnRef,
            title: '修改', 'aria-label': '修改',
            disabled: busy || loading || editing,
            onClick: beginEdit,
          }, PencilIcon(14), h('span', { className: 'recast-label' }, loading ? '读取提问…' : '修改')),
        )

        var panel = editing ? h('div', {
          className: 'recast-panel',
          style: { left: (pos ? pos.x : 24) + 'px', top: (pos ? pos.y : 24) + 'px' },
        },
          h('div', { className: 'recast-panel-head', onPointerDown: startDrag },
            h('span', { className: 'recast-panel-title' }, dragging ? '松开鼠标放下' : '修改提问 · 按住此条拖动'),
            h('button', {
              type: 'button', className: 'recast-panel-close', 'aria-label': '关闭',
              onPointerDown: function (event) { event.stopPropagation() },
              onClick: function () { setEditing(false); setError(null) },
            }, '×')),
          h('textarea', {
            className: 'recast-area recast-area-floating',
            value: draft,
            autoFocus: true,
            onChange: function (event) { setDraft(event.target.value) },
          }),
          h('div', { className: 'recast-row' },
            h('button', {
              type: 'button', className: 'recast-primary', disabled: busy || draft.trim() === '',
              onClick: function () {
                run({ action: 'edit', sessionId: props.sessionId, messageId: props.messageId, text: draft },
                  function () { setEditing(false) })
              },
            }, busy ? '重问中…' : '确认修改'),
            h('button', {
              type: 'button', className: 'recast-ghost', disabled: busy,
              onClick: function () { setEditing(false); setError(null) },
            }, '取消'),
            h('span', { className: 'recast-note' }, '拖动标题条移动，拖右下角改大小')),
          error ? h('div', { className: 'recast-err' }, error) : null,
        ) : null

        var body = [toolbar]
        if (!editing && (note || error)) {
          body.push(h('div', { className: 'recast-row', key: 'feedback' },
            error ? h('span', { className: 'recast-err' }, error) : h('span', { className: 'recast-ok' }, note)))
        }
        if (panel) body.push(panel)

        return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' } }, body)
      }

      ctx.effect(function () {
        return slots.inject('conversation.chat.assistant-actions', function () {
          return slots.register(
            {
              name: 'conversation.chat.assistant-actions',
              id: 'chat-recast-actions',
              order: 21,
              label: function () {
                var zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
                return zh ? '重新生成 / 修改' : 'Regenerate / edit'
              },
            },
            RecastEntry,
          )
        })
      }, 'dsh-chat-recast: 重新生成 / 修改')
    }

    return module.exports
  },
})
