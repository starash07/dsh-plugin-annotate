/**
 * Selection quote reply — the browser half of `dsh-quote-reply`.
 *
 * Select text inside an assistant reply and right-click: the context menu shows
 * "copy" plus "reply here" (在此回答). The popover writes one normal user
 * message that quotes the exact location (message id, turn, block, character
 * range or code lines) together with the selected text, then submits it through
 * the resident composer, so queueing, steering and attachments keep working.
 *
 * The message content stays plain text: no session event type is added, so
 * fork / replay / search see an ordinary user turn.
 *
 * No per-message action row is required. The composer bridge comes from the
 * always-mounted floating seat inside the composer card, and message identity
 * is read from the React fiber chain above the selected text.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-annotate',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'codex-annotate'
    const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,ul,ol,pre,blockquote,table,figure'
    // 注释与对话正文之间的分隔标记（不可见字符），只用于渲染时切分。
    const NOTE_SPLIT = '\u2063'

    const DICTS = {
      'zh-CN': {
        replyHere: '在此回答',
        copy: '复制',
        title: '引用回复',
        close: '关闭',
        placeholder: '针对这段内容继续问…',
        hint: 'Enter 添加 · Shift+Enter 换行',
        cancel: '取消',
        send: '发送',
        sending: '发送中…',
        confirm: '确认',
        clear: '清空',
        remove: '移除',
        pendingTitle: '{n} 条注释',
        quoteLabel: '回复引用',
        assistant: '助手消息',
        turn: '第 {n} 轮',
        paragraph: '第 {n} 段',
        paragraphRange: '第 {a}–{b} 段',
        chars: '字符 {a}–{b}',
        codeBlock: '代码块 {lang}',
        code: '文本',
        lines: '第 {a}–{b} 行',
        section: '「{h}」',
        truncated: '（已截断）',
        annotations: '{n} 条注释',
        errorStale: '输入框内容已变化，请重试',
        errorTimeout: '发送超时，请重试',
        errorNoTarget: '暂时无法定位这条回复，请刷新页面后重试',
        errorBusy: '上一条引用还在发送中',
        errorFailed: '发送失败，请重试',
      },
      'en-US': {
        replyHere: 'Reply here',
        copy: 'Copy',
        title: 'Quote reply',
        close: 'Close',
        placeholder: 'Ask about this passage…',
        hint: 'Enter to add · Shift+Enter for a new line',
        cancel: 'Cancel',
        send: 'Send',
        sending: 'Sending…',
        confirm: 'Confirm',
        clear: 'Clear',
        remove: 'Remove',
        pendingTitle: '{n} notes',
        quoteLabel: 'Quoted reply',
        assistant: 'Assistant message',
        turn: 'turn {n}',
        paragraph: 'paragraph {n}',
        paragraphRange: 'paragraphs {a}–{b}',
        chars: 'chars {a}–{b}',
        codeBlock: 'code block {lang}',
        code: 'text',
        lines: 'lines {a}–{b}',
        section: '“{h}”',
        truncated: '(truncated)',
        annotations: '{n} annotation(s)',
        errorStale: 'The composer changed; please try again',
        errorTimeout: 'Sending timed out; please try again',
        errorNoTarget: 'This reply cannot be located right now; refresh and retry',
        errorBusy: 'The previous quote is still sending',
        errorFailed: 'Sending failed; please retry',
      },
    }

    /** sessionId -> composer bridge { sessionId, send }. */
    const composerBridges = new Map()
    /** The single in-flight composer send. */
    const pendingSend = { current: null }

    // ── generic helpers ──────────────────────────────────────────────────────

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    function format(template, params) {
      if (params === undefined || params === null) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (
        params[key] === undefined ? match : String(params[key])
      ))
    }

    function fallbackTranslate(key, params) {
      const template = DICTS['zh-CN'][key] !== undefined ? DICTS['zh-CN'][key] : DICTS['en-US'][key]
      return format(template !== undefined ? template : key, params)
    }

    function makeTranslator(locale) {
      let bound = null
      if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
        try {
          bound = locale.bind(NS)
        } catch {
          bound = null
        }
      }
      return (key, params) => {
        if (bound !== null) {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch {
            /* fall through to the local dictionary */
          }
        }
        return fallbackTranslate(key, params)
      }
    }

    function shortId(messageId) {
      const text = String(messageId)
      return text.length > 8 ? text.slice(0, 8) : text
    }

    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : node.parentElement
    }

    function quoteError(code) {
      return { code }
    }

    function selectionRect(range) {
      const rects = range.getClientRects()
      for (let i = rects.length - 1; i >= 0; i -= 1) {
        const rect = rects[i]
        if (rect.width > 0 || rect.height > 0) {
          return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }
        }
      }
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom }
    }

    // ── React fiber lookup: message identity without CSS class assumptions ───

    function reactFiberOf(element) {
      for (const key of Object.getOwnPropertyNames(element)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          return element[key]
        }
      }
      return null
    }

    /**
     * Walk the fiber chain above `startEl` for the durable session and message
     * identity. The rendered assistant node carries `node.data.finalNode`.
     */
    function fiberContext(startEl) {
      const context = { sessionId: null, messageId: null, turn: null }
      let fiber = reactFiberOf(startEl)
      let hops = 0
      while (fiber !== null && fiber !== undefined && hops < 120) {
        const props = fiber.memoizedProps
        if (props !== null && typeof props === 'object') {
          if (context.sessionId === null && typeof props.sessionId === 'string') {
            context.sessionId = props.sessionId
          }
          const candidate = props.node
          if (candidate !== null && typeof candidate === 'object') {
            const data = candidate.data
            if (data !== null && typeof data === 'object' && data.finalNode !== null && data.finalNode !== undefined
              && typeof data.finalNode.messageId === 'string') {
              context.messageId = data.finalNode.messageId
            } else if (context.messageId === null && typeof candidate.messageId === 'string') {
              context.messageId = candidate.messageId
            }
            if (context.turn === null && candidate.location !== null && candidate.location !== undefined) {
              const turn = candidate.location.turn
              if (turn !== null && turn !== undefined && typeof turn.turn === 'number') context.turn = turn.turn
            }
            if (context.turn === null && data !== null && typeof data === 'object' && typeof data.turn === 'number') {
              context.turn = data.turn
            }
          }
          if (context.messageId === null && typeof props.messageId === 'string') {
            context.messageId = props.messageId
          }
        }
        fiber = fiber.return
        hops += 1
      }
      return context
    }

    // ── selection → message location ─────────────────────────────────────────

    function topBlocks(wrapper) {
      const blocks = []
      for (const element of wrapper.querySelectorAll(BLOCK_SELECTOR)) {
        let ancestor = element.parentElement
        let nested = false
        while (ancestor !== null && ancestor !== wrapper) {
          if (ancestor.matches(BLOCK_SELECTOR)) {
            nested = true
            break
          }
          ancestor = ancestor.parentElement
        }
        if (!nested) blocks.push(element)
      }
      return blocks
    }

    function blockIndexOf(blocks, node) {
      for (let i = 0; i < blocks.length; i += 1) {
        if (blocks[i].contains(node)) return i
      }
      return -1
    }

    function headingBefore(wrapper, block) {
      let found = null
      for (const heading of wrapper.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        const position = block.compareDocumentPosition(heading)
        if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) found = heading.textContent.trim()
      }
      if (found === null) return null
      return found.length > 40 ? found.slice(0, 40) + '…' : found
    }

    function blockKindOf(block) {
      const tag = block.tagName.toLowerCase()
      if (tag === 'pre') return 'code'
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading'
      if (tag === 'ul' || tag === 'ol') return 'list'
      if (tag === 'blockquote') return 'quote'
      if (tag === 'table') return 'table'
      return 'paragraph'
    }

    function codeLanguage(block) {
      const code = block.querySelector('code')
      const className = code !== null && typeof code.className === 'string' ? code.className : ''
      const found = /language-([A-Za-z0-9_+-]+)/.exec(className)
      return found === null ? null : found[1]
    }

    function describeBlock(block, blocks, startIndex, range, text, wrapper) {
      const endIndexRaw = blocks.length === 0 ? -1 : blockIndexOf(blocks, range.endContainer)
      const endIndex = endIndexRaw < 0 ? startIndex : endIndexRaw
      const kind = blockKindOf(block)
      const before = document.createRange()
      before.selectNodeContents(block)
      before.setEnd(range.startContainer, range.startOffset)
      const prefixText = before.toString()
      const startOffset = prefixText.length
      const endOffset = startOffset + text.length
      const lineStart = prefixText.split('\n').length
      const lineEnd = lineStart + text.split('\n').length - 1
      return {
        kind,
        blockIndex: startIndex >= 0 ? startIndex + 1 : null,
        blockIndexEnd: endIndex >= 0 ? endIndex + 1 : null,
        startOffset,
        endOffset,
        lineStart,
        lineEnd,
        lang: kind === 'code' ? codeLanguage(block) : null,
        heading: kind === 'heading'
          ? block.textContent.trim().slice(0, 40)
          : (wrapper === null ? null : headingBefore(wrapper, block)),
      }
    }

    function buildLocator(info, t) {
      const parts = [t('assistant')]
      if (info.messageId !== null && info.messageId !== undefined) {
        parts[0] = parts[0] + ' #' + shortId(info.messageId)
      }
      if (info.turn !== null && info.turn !== undefined && info.turn !== '') {
        parts.push(t('turn', { n: info.turn }))
      }
      const block = info.block
      if (block === null) return parts.join(' · ')
      if (block.kind === 'code') {
        parts.push(t('codeBlock', { lang: block.lang !== null ? block.lang : t('code') }))
        parts.push(t('lines', { a: block.lineStart, b: block.lineEnd }))
        return parts.join(' · ')
      }
      if (block.blockIndex !== null) {
        if (block.blockIndexEnd !== null && block.blockIndexEnd > block.blockIndex) {
          parts.push(t('paragraphRange', { a: block.blockIndex, b: block.blockIndexEnd }))
        } else {
          parts.push(t('paragraph', { n: block.blockIndex }))
        }
      }
      if (block.heading) parts.push(t('section', { h: block.heading }))
      parts.push(t('chars', { a: block.startOffset, b: block.endOffset }))
      return parts.join(' · ')
    }

    function pickBridge(sessionId) {
      if (sessionId !== null) {
        const exact = composerBridges.get(sessionId)
        if (exact !== undefined) return exact
      }
      if (composerBridges.size === 1) {
        for (const bridge of composerBridges.values()) return bridge
      }
      return undefined
    }

    /**
     * Resolve one DOM selection inside a finalized assistant reply.
     * @returns {{ target: object, rect: object } | null}
     */
    function readTarget(range, text, t) {
      const startEl = elementOf(range.startContainer)
      if (startEl === null) return null
      if (startEl.closest('[data-codex-ui]') !== null) return null
      if (startEl.closest('input,textarea,[contenteditable="true"],[contenteditable=""]') !== null) return null
      const wrapper = startEl.closest('[data-chat-flow-kind]')
      const flowKind = wrapper === null ? null : wrapper.getAttribute('data-chat-flow-kind')
      const inChat = startEl.closest('[data-chat-flow]') !== null
      let context
      try {
        context = fiberContext(startEl)
      } catch {
        context = { sessionId: null, messageId: null, turn: null }
      }
      if (context.messageId === null) {
        if (flowKind !== null && flowKind !== 'assistant-step') return null
        // Unknown build without flow attributes: stay permissive inside the
        // chat column, but never widen past it.
        if (flowKind === null && !inChat) return null
      }
      const bridge = pickBridge(context.sessionId)
      // A missing composer bridge must not hide the menu: the panel reports it
      // when the user tries to send, which is easier to diagnose than silence.
      const blocks = wrapper === null ? [] : topBlocks(wrapper)
      const startIndex = blocks.length === 0 ? -1 : blockIndexOf(blocks, startEl)
      const block = startIndex >= 0 ? blocks[startIndex] : startEl.closest(BLOCK_SELECTOR)
      const info = block === null || block === undefined
        ? null
        : describeBlock(block, blocks, startIndex, range, text, wrapper)
      let turn = context.turn
      if (turn === null && wrapper !== null) {
        const raw = wrapper.getAttribute('data-chat-turn')
        if (raw !== null && raw !== '') turn = raw
      }
      const locator = buildLocator({ messageId: context.messageId, turn, block: info }, t)
      const rect = selectionRect(range)
      if (rect === null) return null
      const preview = text.length > 160 ? text.slice(0, 160) + '…' : text
      return {
        rect,
        target: {
          bridge,
          messageId: context.messageId,
          sessionId: context.sessionId,
          locator,
          preview,
          quote: text,
          code: info !== null && info.kind === 'code',
          lang: info !== null ? info.lang : null,
        },
      }
    }

    // ── outgoing message ─────────────────────────────────────────────────────

    function longestBacktickRun(text) {
      let longest = 0
      let current = 0
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '`') {
          current += 1
          if (current > longest) longest = current
        } else {
          current = 0
        }
      }
      return longest
    }

    function buildMessage(target, reply, t) {
      const lines = ['> **' + t('quoteLabel') + '** · ' + target.locator]
      if (target.code) {
        const fence = '`'.repeat(Math.max(3, longestBacktickRun(target.quote) + 1))
        const codeLines = target.quote.split('\n')
        const kept = codeLines.slice(0, 12)
        lines.push('> ' + fence + (target.lang !== null ? target.lang : ''))
        for (const line of kept) lines.push('> ' + line)
        if (codeLines.length > kept.length) lines.push('> ' + t('truncated'))
        lines.push('> ' + fence)
      } else {
        const clipped = target.quote.length > 300 ? target.quote.slice(0, 300) : target.quote
        for (const line of clipped.split('\n')) lines.push('> ' + line)
        if (clipped.length < target.quote.length) lines.push('> ' + t('truncated'))
      }
      return lines.join('\n') + '\n\n' + reply.trim()
    }

    // ── collapse the rendered quote inside the user bubble ───────────────────
    //
    // The quote stays in the message text (the model must see it), but the
    // bubble shows an attachment-like chip instead. Host markdown renders the
    // quote as a <blockquote>; we tag those blocks and let CSS hide their
    // children until the chip is expanded.

    const QUOTE_LABELS = [DICTS['zh-CN'].quoteLabel, DICTS['en-US'].quoteLabel]

    function isQuoteText(text) {
      for (const label of QUOTE_LABELS) {
        if (text.startsWith(label)) return true
      }
      return false
    }

    function toggleQuoteBlock(block) {
      const open = block.hasAttribute('data-codex-open')
      if (open) block.removeAttribute('data-codex-open')
      else block.setAttribute('data-codex-open', '')
      block.setAttribute('aria-expanded', open ? 'false' : 'true')
    }

    function tagQuoteBlocks(t) {
      const blocks = document.querySelectorAll('blockquote')
      const groups = new Map()
      for (const block of blocks) {
        if (block.closest('[data-codex-ui]') !== null) continue
        // Assistant prose may quote arbitrary text; only tag user bubbles.
        if (block.closest('[data-chat-flow-kind="assistant-step"]') !== null) continue
        const text = (block.textContent === null ? '' : block.textContent).trim()
        if (!isQuoteText(text)) continue
        const root = block.closest('[data-chat-flow-kind]') || block.parentElement
        if (root === null) continue
        let list = groups.get(root)
        if (list === undefined) {
          list = []
          groups.set(root, list)
        }
        list.push(block)
      }
      for (const list of groups.values()) {
        const label = t('annotations', { n: list.length })
        for (const block of list) {
          if (block.getAttribute('data-codex-label') !== label) block.setAttribute('data-codex-label', label)
          if (!block.hasAttribute('data-codex-quote')) {
            block.setAttribute('data-codex-quote', '')
            block.setAttribute('role', 'button')
            block.setAttribute('tabindex', '0')
            block.setAttribute('aria-expanded', 'false')
            const title = (block.textContent === null ? '' : block.textContent).trim().split('\n')[0]
            if (title !== '') block.setAttribute('title', title.slice(0, 160))
          }
        }
      }
    }

    // ── composer bridge ──────────────────────────────────────────────────────

    function settleSend(entry, error) {
      if (entry.done) return
      entry.done = true
      window.clearTimeout(entry.timer)
      if (pendingSend.current === entry) pendingSend.current = null
      if (error !== null) entry.reject(error)
      else entry.resolve('sent')
    }

    function commitSend(entry) {
      if (entry.done || entry.submitting) return
      entry.submitting = true
      try {
        entry.actions.submit()
      } catch {
        settleSend(entry, quoteError('failed'))
        return
      }
      settleSend(entry, null)
    }

    function sendThroughComposer(latest, text, options) {
      return new Promise((resolve, reject) => {
        const state = latest.current
        const actions = state.inputActions
        if (actions === null || actions === undefined || typeof actions.submit !== 'function') {
          reject(quoteError('no-target'))
          return
        }
        if (pendingSend.current !== null) {
          reject(quoteError('busy'))
          return
        }
        const draft = state.draft
        const prepend = options !== undefined && options !== null && options.prepend === true
        const prefix = draft.trim() === '' ? '' : '\n\n'
        // prepend: 注释放最前面，用不可见标记隔开对话正文，便于气泡里分栏。
        const expected = prepend
          ? (draft.trim() === '' ? text : text + NOTE_SPLIT + '\n\n' + draft)
          : draft + prefix + text
        const entry = {
          sessionId: state.sessionId,
          expected,
          resolve,
          reject,
          actions,
          done: false,
          submitting: false,
          readDraft: () => latest.current.draft,
          timer: 0,
        }
        // The editor may commit asynchronously: submit as soon as the draft
        // reflects the composed text, and only fall back to the timer.
        entry.timer = window.setTimeout(() => {
          if (entry.done) return
          if (entry.readDraft() === entry.expected) {
            commitSend(entry)
            return
          }
          settleSend(entry, quoteError('timeout'))
        }, 1500)
        pendingSend.current = entry
        try {
          const atStart = prepend && draft.trim() !== ''
          if (draft.trim() !== '' && typeof actions.insertText === 'function') {
            const at = atStart ? 0 : draft.length
            const span = { start: at, end: at, draftRev: state.rev }
            const insert = atStart ? text + NOTE_SPLIT + '\n\n' : prefix + text
            if (!actions.insertText(insert, span)) {
              settleSend(entry, quoteError('stale'))
            }
          } else if (typeof actions.setDraft === 'function') {
            actions.setDraft(expected)
          } else {
            settleSend(entry, quoteError('no-target'))
          }
        } catch {
          settleSend(entry, quoteError('failed'))
        }
      })
    }

    // 只把文本写进输入框，不提交：确认注释后立即插入，随后用户用正常发送键一起发出。
    function insertThroughComposer(latest, text) {
      return new Promise((resolve, reject) => {
        const state = latest.current
        const actions = state.inputActions
        if (actions === null || actions === undefined) {
          reject(quoteError('no-target'))
          return
        }
        const draft = state.draft
        const prefix = draft.trim() === '' ? '' : '\n\n'
        const expected = draft + prefix + text
        try {
          if (draft.trim() !== '' && typeof actions.insertText === 'function') {
            const span = { start: draft.length, end: draft.length, draftRev: state.rev }
            if (!actions.insertText(prefix + text, span)) {
              reject(quoteError('stale'))
              return
            }
          } else if (typeof actions.setDraft === 'function') {
            actions.setDraft(expected)
          } else {
            reject(quoteError('no-target'))
            return
          }
        } catch {
          reject(quoteError('failed'))
          return
        }
        let tries = 0
        const settle = () => {
          if (latest.current.draft === expected) {
            resolve('inserted')
            return
          }
          if (++tries > 40) {
            reject(quoteError('timeout'))
            return
          }
          window.setTimeout(settle, 40)
        }
        settle()
      })
    }

    function ComposerBridge(props) {
      if (typeof props.useInput === 'function') return h(ComposerBridgeLive, props)
      return h(ComposerBridgeFallback, props)
    }

    function ComposerBridgeLive(props) {
      const state = props.useInput(s => s)
      const latest = React.useRef({ draft: '', rev: 0, inputActions: null, sessionId: props.sessionId })
      latest.current.draft = state !== null && state !== undefined && typeof state.draft === 'string' ? state.draft : ''
      latest.current.rev = state !== null && state !== undefined && typeof state.draftRev === 'number' ? state.draftRev : 0
      latest.current.inputActions = props.inputActions
      latest.current.sessionId = props.sessionId

      React.useEffect(() => {
        if (typeof props.sessionId !== 'string') return undefined
        const bridge = { sessionId: props.sessionId, send: (text, options) => sendThroughComposer(latest, text, options), insert: text => insertThroughComposer(latest, text) }
        composerBridges.set(props.sessionId, bridge)
        return () => {
          if (composerBridges.get(props.sessionId) === bridge) composerBridges.delete(props.sessionId)
        }
      }, [props.sessionId])

      const draft = latest.current.draft
      React.useEffect(() => {
        const entry = pendingSend.current
        if (entry === null || entry.done || entry.submitting) return
        if (entry.sessionId !== props.sessionId) return
        if (draft !== entry.expected) return
        commitSend(entry)
      }, [draft, props.sessionId])

      return null
    }

    function ComposerBridgeFallback(props) {
      React.useEffect(() => {
        if (typeof props.sessionId !== 'string') return undefined
        const bridge = {
          sessionId: props.sessionId,
          send: text => new Promise((resolve, reject) => {
            const actions = props.inputActions
            if (actions === null || actions === undefined
              || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
              reject(quoteError('no-target'))
              return
            }
            try {
              actions.setDraft(text)
              window.setTimeout(() => {
                try {
                  actions.submit()
                  resolve('sent')
                } catch {
                  reject(quoteError('failed'))
                }
              }, 30)
            } catch {
              reject(quoteError('failed'))
            }
          }),
        }
        composerBridges.set(props.sessionId, bridge)
        return () => {
          if (composerBridges.get(props.sessionId) === bridge) composerBridges.delete(props.sessionId)
        }
      }, [props.sessionId, props.inputActions])
      return null
    }

    // ── pending annotations (confirmed, not yet sent) ───────────────────────

    let noteSeq = 0
    const notesStore = { items: [], listeners: new Set() }
    const notesPanelStore = { current: null, listeners: new Set() }

    function emitNotes() {
      for (const listener of Array.from(notesStore.listeners)) {
        try {
          listener()
        } catch {
          /* one bad listener must not stop the rest */
        }
      }
    }

    function addNote(note) {
      notesStore.items = [...notesStore.items, note]
      emitNotes()
    }

    function removeNote(id) {
      notesStore.items = notesStore.items.filter(note => note.id !== id)
      emitNotes()
    }

    function clearNotes(sessionId) {
      notesStore.items = notesStore.items.filter(note => note.sessionId !== sessionId)
      emitNotes()
    }

    function useNotes() {
      const [items, setItems] = React.useState(notesStore.items)
      React.useEffect(() => {
        const listener = () => setItems(notesStore.items)
        notesStore.listeners.add(listener)
        listener()
        return () => { notesStore.listeners.delete(listener) }
      }, [])
      return items
    }

    function setNotesPanel(next) {
      notesPanelStore.current = next
      for (const listener of Array.from(notesPanelStore.listeners)) {
        try {
          listener()
        } catch {
          /* one bad listener must not stop the rest */
        }
      }
    }

    function useNotesPanel() {
      const [panel, setPanel] = React.useState(notesPanelStore.current)
      React.useEffect(() => {
        const listener = () => setPanel(notesPanelStore.current)
        notesPanelStore.listeners.add(listener)
        return () => { notesPanelStore.listeners.delete(listener) }
      }, [])
      return panel
    }

    function clipNote(text) {
      const line = String(text).trim().split('\n')[0]
      return line.length > 26 ? line.slice(0, 26) + '…' : line
    }

    function noteFailure(t, reason) {
      const code = reason !== null && typeof reason === 'object' ? reason.code : ''
      if (code === 'stale') return t('errorStale')
      if (code === 'timeout') return t('errorTimeout')
      if (code === 'busy') return t('errorBusy')
      if (code === 'no-target') return t('errorNoTarget')
      return t('errorFailed')
    }

    /** Compact chip inside the composer tool row; opens the annotation list. */
    function NotesChip(props) {
      const t = props.t
      const notes = useNotes().filter(note => note.sessionId === props.sessionId)
      const open = useNotesPanel()
      const ref = React.useRef(null)
      if (notes.length === 0) return null
      const expanded = open !== null && open.sessionId === props.sessionId
      const toggle = () => {
        if (expanded) {
          setNotesPanel(null)
          return
        }
        const el = ref.current
        const rect = el === null ? null : el.getBoundingClientRect()
        setNotesPanel({
          sessionId: props.sessionId,
          chipEl: el,
          rect: rect === null
            ? null
            : { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom },
        })
      }
      return h('button', {
        ref,
        type: 'button',
        'data-codex-ui': '',
        className: 'codexNotesChipBtn',
        'aria-haspopup': 'dialog',
        'aria-expanded': expanded ? 'true' : 'false',
        title: t('annotations', { n: notes.length }),
        onClick: toggle,
      },
      h('span', { 'aria-hidden': true, className: 'codexNotesChipIcon' }, '📎'),
      h('span', null, t('annotations', { n: notes.length })))
    }

    function placeNotesPanel(rect) {
      const width = Math.min(400, window.innerWidth - 16)
      const left = rect === null ? 8 : clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8))
      const bottom = rect === null ? 80 : Math.max(8, window.innerHeight - rect.top + 8)
      return { left: left + 'px', bottom: bottom + 'px', width: width + 'px' }
    }

    /** Expanded list of confirmed annotations, floating above the chip. */
    function NotesPanel(props) {
      const t = props.t
      const state = props.state
      const notes = useNotes().filter(note => note.sessionId === state.sessionId)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        if (notes.length === 0) setNotesPanel(null)
      }, [notes.length])

      if (notes.length === 0) return null

      const sendAll = () => {
        if (busy) return
        const bridge = pickBridge(state.sessionId)
        if (bridge === undefined) {
          setError(t('errorNoTarget'))
          return
        }
        const text = notes.map(note => buildMessage(note, note.reply, t)).join('\n\n')
        setBusy(true)
        setError('')
        bridge.send(text, { prepend: true }).then(() => {
          setBusy(false)
          clearNotes(state.sessionId)
          setNotesPanel(null)
        }, reason => {
          setBusy(false)
          setError(noteFailure(t, reason))
        })
      }

      return h('div', {
        'data-codex-ui': '',
        className: 'codexNotesPanel',
        role: 'dialog',
        'aria-label': t('title'),
        style: placeNotesPanel(state.rect),
      },
      h('div', { className: 'codexNotesPanelHead' },
        h('span', { className: 'codexNotesPanelTitle' }, '📎 ' + t('annotations', { n: notes.length })),
        h('button', {
          type: 'button',
          className: 'codexAnnotateClose',
          'aria-label': t('close'),
          title: t('close'),
          onClick: () => setNotesPanel(null),
        }, '×')),
      h('div', { className: 'codexNotesPanelList' },
        notes.map(note => h('div', { key: note.id, className: 'codexNotesRow' },
          h('div', { className: 'codexNotesRowMain' },
            h('div', { className: 'codexNotesRowText' }, note.reply),
            h('div', { className: 'codexNotesRowMeta' }, note.locator)),
          h('button', {
            type: 'button',
            className: 'codexNotesRemove',
            'aria-label': t('remove'),
            title: t('remove'),
            onClick: () => removeNote(note.id),
          }, '×')))),
      error === '' ? null : h('div', { className: 'codexAnnotateError', role: 'alert' }, error),
      h('div', { className: 'codexNotesPanelFoot' },
        h('button', {
          type: 'button',
          className: 'codexNotesGhost',
          disabled: busy,
          onClick: () => clearNotes(state.sessionId),
        }, t('clear')),
        h('button', {
          type: 'button',
          className: 'codexNotesSend',
          disabled: busy,
          onClick: sendAll,
        }, busy ? t('sending') : t('send'))))
    }

    // ── overlay: context menu + quote popover ────────────────────────────────

    function copyIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true,
        style: { flex: 'none', display: 'block' },
      }, h('path', {
        d: 'M5.5 2h5A1.5 1.5 0 0 1 12 3.5v7a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-7A1.5 1.5 0 0 1 5.5 2Zm0 1.2a.3.3 0 0 0-.3.3v7c0 .17.13.3.3.3h5a.3.3 0 0 0 .3-.3v-7a.3.3 0 0 0-.3-.3h-5Z',
        fill: 'currentColor',
      }), h('path', {
        d: 'M2.6 4.6h1.2v7.6c0 .35.28.63.63.63h4.9v1.2h-4.9A1.83 1.83 0 0 1 2.6 12.2V4.6Z',
        fill: 'currentColor',
      }))
    }

    function quoteGlyph(size) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size === undefined ? 13 : size, height: size === undefined ? 13 : size,
        'aria-hidden': true, style: { flex: 'none', display: 'block' },
      }, h('path', {
        d: 'M3 3h4v5H4.6c0 1.9.8 2.9 2.4 3v2C4 13 3 11 3 8V3Zm6 0h4v5H10.6c0 1.9.8 2.9 2.4 3v2c-3 0-4-2-4-5V3Z',
        fill: 'currentColor',
      }))
    }

    function placeMenu(x, y) {
      const width = 184
      const height = 84
      return {
        top: clamp(y, 8, Math.max(8, window.innerHeight - height - 8)) + 'px',
        left: clamp(x, 8, Math.max(8, window.innerWidth - width - 8)) + 'px',
      }
    }

    function placePanel(rect) {
      const width = Math.min(360, window.innerWidth - 16)
      const left = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8))
      const below = window.innerHeight - rect.bottom > 300
      if (below) {
        return {
          top: Math.max(8, rect.bottom + 8) + 'px',
          left: left + 'px',
          width: width + 'px',
        }
      }
      return {
        bottom: Math.max(8, window.innerHeight - rect.top + 8) + 'px',
        left: left + 'px',
        width: width + 'px',
      }
    }

    function fallbackCopy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      } catch {
        /* clipboard unavailable; nothing else to try */
      }
    }

    function Annotator(props) {
      const t = props.t
      const tRef = React.useRef(t)
      tRef.current = t

      const [menu, setMenu] = React.useState(null)
      const [panel, setPanel] = React.useState(null)
      const [reply, setReply] = React.useState('')
      const [error, setError] = React.useState('')
      const notesPanel = useNotesPanel()

      const panelRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const popRef = React.useRef(null)
      const inputRef = React.useRef(null)
      panelRef.current = panel

      React.useEffect(() => {
        const onContext = event => {
          if (panelRef.current !== null) return
          const target = elementOf(event.target)
          if (target === null) return
          if (target.closest('[data-codex-ui]') !== null) return
          if (target.closest('input,textarea,[contenteditable="true"],[contenteditable=""]') !== null) return
          const selection = window.getSelection()
          if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return
          const range = selection.getRangeAt(0)
          const text = selection.toString().replace(/\s+$/, '')
          if (text.trim() === '') return
          const resolved = readTarget(range, text, tRef.current)
          if (resolved === null) return
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY, target: resolved.target, rect: resolved.rect })
        }
        document.addEventListener('contextmenu', onContext, true)
        return () => document.removeEventListener('contextmenu', onContext, true)
      }, [])

      React.useEffect(() => {
        let frame = 0
        const sync = () => {
          frame = 0
          tagQuoteBlocks(tRef.current)
        }
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(sync)
        }
        const onQuoteClick = event => {
          const target = event.target
          if (!(target instanceof Element)) return
          const block = target.closest('blockquote[data-codex-quote]')
          if (block === null || target !== block) return
          const selection = window.getSelection()
          if (selection !== null && !selection.isCollapsed) return
          event.preventDefault()
          event.stopPropagation()
          toggleQuoteBlock(block)
        }
        const onQuoteKey = event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          const target = event.target
          if (!(target instanceof Element)) return
          const block = target.closest('blockquote[data-codex-quote]')
          if (block === null || target !== block) return
          event.preventDefault()
          event.stopPropagation()
          toggleQuoteBlock(block)
        }
        sync()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        document.addEventListener('click', onQuoteClick, true)
        document.addEventListener('keydown', onQuoteKey, true)
        return () => {
          observer.disconnect()
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('click', onQuoteClick, true)
          document.removeEventListener('keydown', onQuoteKey, true)
        }
      }, [])

      React.useEffect(() => {
        if (notesPanel === null) return
        // Opening the annotation list dismisses the quote editor.
        setMenu(null)
        setPanel(null)
        setReply('')
        setError('')
      }, [notesPanel])

      React.useEffect(() => {
        if (menu === null && panel === null && notesPanel === null) return undefined
        const onDown = event => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-codex-ui]') !== null) return
          setMenu(null)
          if (panel !== null) {
            setPanel(null)
            setReply('')
            setError('')
          }
          if (notesPanel !== null) setNotesPanel(null)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [menu, panel, notesPanel])

      React.useEffect(() => {
        if (menu === null && panel === null && notesPanel === null) return undefined
        const onKey = event => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setMenu(null)
          setPanel(null)
          setReply('')
          setError('')
          setNotesPanel(null)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [menu, panel, notesPanel])

      React.useEffect(() => {
        if (menu === null && notesPanel === null) return undefined
        const onScroll = event => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-codex-ui]') !== null) return
          if (menu !== null) setMenu(null)
          if (notesPanel !== null) setNotesPanel(null)
        }
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [menu, notesPanel])

      React.useEffect(() => {
        if (panel === null) return
        const node = inputRef.current
        if (node === null) return
        node.focus()
        node.setSelectionRange(node.value.length, node.value.length)
      }, [panel])

      const closePanel = () => {
        setPanel(null)
        setReply('')
        setError('')
      }

      const copySelection = () => {
        if (menu === null) return
        const text = menu.target.quote
        setMenu(null)
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).catch(() => { fallbackCopy(text) })
        } else {
          fallbackCopy(text)
        }
      }

      const openPanel = () => {
        if (menu === null) return
        const target = menu.target
        const rect = menu.rect
        setMenu(null)
        setPanel({ target, rect })
        setReply('')
        setError('')
      }

      const confirm = () => {
        if (panel === null) return
        const value = reply.trim()
        if (value === '') return
        const bridge = pickBridge(panel.target.sessionId)
        const sessionId = panel.target.sessionId !== null
          ? panel.target.sessionId
          : (bridge === undefined ? null : bridge.sessionId)
        noteSeq += 1
        addNote({
          id: 'note-' + String(noteSeq),
          sessionId,
          locator: panel.target.locator,
          quote: panel.target.quote,
          code: panel.target.code,
          lang: panel.target.lang,
          reply: value,
        })
        closePanel()
        const selection = window.getSelection()
        if (selection !== null) selection.removeAllRanges()
      }

      const onKeyDown = event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          closePanel()
          return
        }
        if (event.key !== 'Enter') return
        if (event.shiftKey || event.isComposing || event.nativeEvent.isComposing) return
        event.preventDefault()
        confirm()
      }

      const autoGrow = event => {
        const node = event.currentTarget
        node.style.height = 'auto'
        node.style.height = Math.min(node.scrollHeight, 180) + 'px'
      }

      const menuNode = menu === null ? null : h('div', {
        ref: menuRef,
        'data-codex-ui': '',
        className: 'codexAnnotateMenu',
        role: 'menu',
        'aria-label': t('title'),
        style: placeMenu(menu.x, menu.y),
        onContextMenu: event => event.preventDefault(),
      },
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'codexAnnotateMenuItem',
        onClick: copySelection,
      }, h('span', { className: 'codexAnnotateMenuIcon' }, copyIcon()), h('span', null, t('copy'))),
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'codexAnnotateMenuItem',
        onClick: openPanel,
      }, h('span', { className: 'codexAnnotateMenuIcon' }, quoteGlyph(13)), h('span', null, t('replyHere'))))

      const panelNode = panel === null ? null : h('div', {
        ref: popRef,
        'data-codex-ui': '',
        className: 'codexAnnotatePanel',
        role: 'dialog',
        'aria-label': t('title'),
        style: placePanel(panel.rect),
      },
      h('div', { className: 'codexAnnotateHead' },
        h('span', { className: 'codexAnnotateTitle' }, t('title')),
        h('button', {
          type: 'button',
          className: 'codexAnnotateClose',
          'aria-label': t('close'),
          title: t('close'),
          onClick: closePanel,
        }, '×')),
      h('div', { className: 'codexAnnotateLocator' }, panel.target.locator),
      h('div', { className: 'codexAnnotateQuote' }, panel.target.preview),
      h('textarea', {
        ref: inputRef,
        className: 'codexAnnotateInput',
        rows: 3,
        value: reply,
        placeholder: t('placeholder'),
        'aria-label': t('placeholder'),
        onChange: event => setReply(event.target.value),
        onKeyDown,
        onInput: autoGrow,
      }),
      error === '' ? null : h('div', { className: 'codexAnnotateError', role: 'alert' }, error),
      h('div', { className: 'codexAnnotateFoot' },
        h('span', { className: 'codexAnnotateHint' }, t('hint')),
        h('div', { className: 'codexAnnotateActions' },
          h('button', {
            type: 'button',
            className: 'codexAnnotateBtn',
            onClick: closePanel,
          }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'codexAnnotateBtn codexAnnotatePrimary',
            disabled: reply.trim() === '',
            onClick: confirm,
          }, t('confirm')))))

      const notesNode = notesPanel === null ? null : h(NotesPanel, { t, state: notesPanel })

      return h(React.Fragment, null, menuNode, panelNode, notesNode)
    }

    // ── styles ───────────────────────────────────────────────────────────────

    const CSS = `
.codexAnnotateMenu{
  position:fixed; z-index:72; box-sizing:border-box; min-width:184px; padding:4px;
  pointer-events:auto; border-radius:10px; font-size:12.5px;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1); box-shadow:0 10px 30px rgba(0,0,0,.22);
}
.codexAnnotateMenuItem{
  display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box;
  height:30px; padding:0 10px; border:0; border-radius:6px; cursor:pointer;
  background:transparent; color:var(--dsw-alias-label-primary); font:inherit; text-align:left;
  white-space:nowrap;
}
.codexAnnotateMenuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.codexAnnotateMenuItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px}
.codexAnnotateMenuIcon{display:inline-flex; width:14px; justify-content:center; color:var(--dsw-alias-label-secondary)}
.codexAnnotatePanel{
  position:fixed; z-index:71; box-sizing:border-box; max-height:70vh; overflow:auto;
  pointer-events:auto;
  padding:12px; border-radius:12px; font-size:13px; line-height:1.5;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1); box-shadow:0 18px 48px rgba(0,0,0,.24);
}
.codexAnnotateHead{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px}
.codexAnnotateTitle{font-weight:600; font-size:13px}
.codexAnnotateClose{
  width:22px; height:22px; border:0; border-radius:6px; cursor:pointer; padding:0;
  background:transparent; color:var(--dsw-alias-label-secondary); font-size:15px; line-height:1;
}
.codexAnnotateClose:hover{background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary)}
.codexAnnotateLocator{font-size:11px; line-height:1.4; color:var(--dsw-alias-label-secondary); margin-bottom:6px}
.codexAnnotateQuote{
  margin:0 0 10px; padding:8px 10px; border-radius:8px; max-height:72px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
  border-left:3px solid var(--dsw-alias-border-l2);
}
.codexAnnotateInput{
  display:block; width:100%; box-sizing:border-box; resize:none; min-height:64px; max-height:180px;
  padding:8px 10px; border-radius:8px; font:inherit; line-height:1.5;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1); outline:none;
}
.codexAnnotateInput:focus{border-color:var(--dsw-alias-brand-primary)}
.codexAnnotateInput::placeholder{color:var(--dsw-alias-label-secondary)}
.codexAnnotateError{margin-top:8px; font-size:12px; color:var(--dsw-alias-state-error-primary)}
.codexAnnotateFoot{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px}
.codexAnnotateHint{font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.codexAnnotateActions{display:flex; align-items:center; gap:8px; flex:none}
.codexAnnotateBtn{
  height:28px; padding:0 12px; border-radius:7px; cursor:pointer; font:inherit; font-size:12px;
  background:transparent; color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);
}
.codexAnnotateBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.codexAnnotateBtn:disabled{opacity:.5; cursor:default}
.codexAnnotatePrimary{
  background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; font-weight:600;
}
.codexAnnotatePrimary:hover:not(:disabled){filter:brightness(1.06); background:var(--dsw-alias-brand-primary)}
.codexNotesChipBtn{
  display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 10px;
  border-radius:999px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  border:1px solid var(--dsw-alias-border-l1);
}
.codexNotesChipBtn:hover{background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary)}
.codexNotesChipIcon{font-size:12px; line-height:1}
.codexNotesPanel{
  position:fixed; z-index:73; box-sizing:border-box; max-height:52vh; overflow:auto;
  padding:12px; border-radius:12px; font-size:13px; line-height:1.5;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1); box-shadow:0 18px 48px rgba(0,0,0,.24);
}
.codexNotesPanelHead{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px}
.codexNotesPanelTitle{font-weight:600; font-size:12.5px}
.codexNotesPanelList{display:flex; flex-direction:column; gap:6px}
.codexNotesRow{
  display:flex; align-items:flex-start; gap:6px; padding:7px 8px; border-radius:8px;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
}
.codexNotesRowMain{min-width:0; flex:1 1 auto}
.codexNotesRowText{
  font-size:12.5px; line-height:1.45; display:-webkit-box;
  -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word;
}
.codexNotesRowMeta{
  margin-top:3px; font-size:10.5px; line-height:1.3; color:var(--dsw-alias-label-secondary);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.codexNotesRemove{
  flex:none; width:20px; height:20px; border:0; border-radius:5px; padding:0; cursor:pointer;
  background:transparent; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1;
}
.codexNotesRemove:hover{background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary)}
.codexNotesPanelFoot{display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:10px}
.codexNotesGhost,.codexNotesSend{height:28px; padding:0 12px; border-radius:7px; cursor:pointer; font:inherit; font-size:12px}
.codexNotesGhost{background:transparent; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1)}
.codexNotesGhost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.codexNotesSend{background:var(--dsw-alias-brand-primary); color:#fff; border:1px solid transparent; font-weight:600}
.codexNotesSend:hover:not(:disabled){filter:brightness(1.06)}
.codexNotesGhost:disabled,.codexNotesSend:disabled{opacity:.5; cursor:default}
html body blockquote[data-codex-quote]{
  margin:3px 0 0 !important; padding:0 !important; border:0 !important;
  background:transparent !important; color:inherit !important; font-size:inherit !important;
}
html body blockquote[data-codex-quote]::before{
  content:"📎 " attr(data-codex-label) "  ▾";
  display:inline-flex; align-items:center; height:24px; padding:0 9px;
  border-radius:7px; cursor:pointer; user-select:none; white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);
  font-size:11.5px !important; line-height:1 !important; font-weight:400 !important;
}
html body blockquote[data-codex-quote][data-codex-open]::before{
  content:"📎 " attr(data-codex-label) "  ▴";
}
html body blockquote[data-codex-quote]:not([data-codex-open]) > *{ display:none !important; }
html body blockquote[data-codex-quote][data-codex-open] > *:first-child{ margin-top:6px !important; }
html body blockquote[data-codex-quote]:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; border-radius:7px;
}
`

    // ── plugin entry ─────────────────────────────────────────────────────────

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-codex-annotate', '')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => {
        if (style.parentNode !== null) style.parentNode.removeChild(style)
      })

      const locale = ctx.get('locale')
      if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
        ctx.effect(() => {
          const disposers = []
          for (const id of ['zh-CN', 'zh', 'en-US', 'en']) {
            const dict = id.indexOf('zh') === 0 ? DICTS['zh-CN'] : DICTS['en-US']
            try {
              const dispose = locale.register(NS, id, dict)
              if (typeof dispose === 'function') disposers.push(dispose)
            } catch {
              /* custom namespaces may not be registrable in every profile */
            }
          }
          return () => { for (const dispose of disposers) dispose() }
        })
      }
      const t = makeTranslator(locale)

      // 把待发送的注释拼进草稿并提交：用户在输入框里按 Enter 或点发送时，
      // 先由这里的捕获监听拦下，拼好引用再走宿主自己的提交路径。
      const flushPendingNotes = sessionId => {
        const notes = notesStore.items.filter(note => note.sessionId === sessionId)
        if (notes.length === 0) return false
        const bridge = pickBridge(sessionId)
        if (bridge === undefined) return false
        const text = notes.map(note => buildMessage(note, note.reply, t)).join('\n\n')
        bridge.send(text, { prepend: true }).then(() => clearNotes(sessionId), () => {})
        return true
      }

      const activeSessionId = () => {
        for (const id of composerBridges.keys()) return id
        return null
      }

      ctx.effect(() => {
        const onKeyDown = event => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
          const target = event.target instanceof Element ? event.target : null
          if (target === null) return
          if (target.closest('[data-codex-ui]') !== null) return
          if (target.closest('[data-composer-card]') === null) return
          if (notesStore.items.length === 0) return
          const sessionId = activeSessionId()
          if (sessionId === null) return
          if (flushPendingNotes(sessionId)) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
        }
        const onClick = event => {
          const target = event.target instanceof Element ? event.target : null
          if (target === null) return
          if (target.closest('[data-codex-ui]') !== null) return
          if (target.closest('[data-composer-card]') === null) return
          const button = target.closest('button')
          if (button === null) return
          if (String(button.className).indexOf('primary') === -1) return
          // 运行中的主按钮是「停止」（rect 图标），不能拦。
          if (button.querySelector('rect') !== null) return
          if (notesStore.items.length === 0) return
          const sessionId = activeSessionId()
          if (sessionId === null) return
          if (flushPendingNotes(sessionId)) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('click', onClick, true)
        }
      })

      // Confirmed annotations live as a compact chip inside the composer tool
      // row; the list expands in the overlay.
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'codex-quote-notes',
        order: 30,
      }, slotProps => h(NotesChip, { ...slotProps, t })))

      // The composer bridge lives on a floating, always-mounted session seat.
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'codex-quote-bridge',
        order: 90,
      }, slotProps => h(ComposerBridge, slotProps)))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'codex-quote-reply',
        order: 30,
      }, () => h(Annotator, { t })))

      // 发送后的显示：引用收进小胶囊（默认不展开），下接一条细线，再下面是你的文字。
      const QUOTE_MARK = '> **回复引用**'
      const FOLD_CSS = '.dshq-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:1px solid rgba(0,0,0,.12);border-radius:999px;font-size:12px;line-height:16px;color:#666;background:rgba(0,0,0,.03);cursor:pointer;user-select:none}.dshq-chip:hover{background:rgba(0,0,0,.07)}.dshq-body{display:none;margin:6px 0 0;white-space:pre-wrap;font-size:12px;line-height:18px;color:#888}.dshq-body[data-open]{display:block}.dshq-note{display:block;margin:5px 0 0;white-space:pre-wrap;font-size:12px;line-height:17px;font-style:italic;color:#7a7a7a}.dshq-divider{display:block;height:1px;margin:8px 0;background:rgba(0,0,0,.12)}'

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-codex-ui', '')
        style.textContent = FOLD_CSS
        document.head.appendChild(style)

        const render = text => {
          const fragment = document.createDocumentFragment()
          const splitAt = text.indexOf(NOTE_SPLIT)
          const left = splitAt === -1 ? text : text.slice(0, splitAt)
          const right = splitAt === -1 ? '' : text.slice(splitAt + NOTE_SPLIT.length).replace(/^\n+/, '')
          const lines = left.split('\n')
          const quoteLines = []
          let index = 0
          while (index < lines.length && lines[index].startsWith('>')) {
            quoteLines.push(lines[index].replace(/^>\s?/, ''))
            index += 1
          }
          const replyText = lines.slice(index).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
          const locator = quoteLines.length > 0 ? quoteLines[0].replace(/\*\*/g, '') : ''
          const quotedText = quoteLines.slice(1).join('\n')
          const count = (quoteLines.join('\n').match(/\*\*回复引用\*\*/g) || []).length || 1

          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'dshq-chip'
          chip.textContent = '❝ ' + String(count) + ' 条注释'
          if (locator !== '') chip.title = locator
          const body = document.createElement('span')
          body.className = 'dshq-body'
          body.textContent = quotedText
          chip.addEventListener('click', () => { body.toggleAttribute('data-open') })

          fragment.appendChild(chip)
          fragment.appendChild(body)
          if (replyText !== '') {
            const note = document.createElement('span')
            note.className = 'dshq-note'
            note.textContent = replyText
            fragment.appendChild(note)
          }
          if (right !== '') {
            const divider = document.createElement('span')
            divider.className = 'dshq-divider'
            fragment.appendChild(divider)
            fragment.appendChild(document.createTextNode(right))
          }
          return fragment
        }

        const fold = () => {
          for (const row of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
            if (row.querySelector('.dshq-chip') !== null) continue
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            let node = null
            while (walker.nextNode()) {
              const text = walker.currentNode.nodeValue
              if (text !== null && text.indexOf(QUOTE_MARK) !== -1) { node = walker.currentNode; break }
            }
            if (node === null) continue
            node.parentNode.replaceChild(render(node.nodeValue), node)
          }
        }

        fold()
        const observer = new MutationObserver(() => { window.requestAnimationFrame(fold) })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        return () => {
          observer.disconnect()
          style.remove()
        }
      })
    }

    return {
      name: 'codex-annotate-client',
      inject: ['slots'],
      apply,
    }
  },
})
