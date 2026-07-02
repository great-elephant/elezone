import { translate } from './translation'
import { getSelectionContext, applyHighlight, pulseHighlight } from './anchor'
import { BookmarkColor, BOOKMARK_COLORS } from '../../shared/types'
import type { ContextTranslateResult } from '../../background/aiTranslate'

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null

const DICTIONARY_CSS = `
  :host { all: initial; }
  .dict-popover {
    position: fixed;
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 8px;
    padding: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    color: #c0c0e0;
    width: 250px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .word-header {
    font-weight: bold;
    font-size: 1.1em;
    color: #ffffff;
  }
  .context-hint {
    font-size: 0.82em;
    color: #6688aa;
    font-style: italic;
    line-height: 1.4;
  }
  .translation-input {
    background: #111122;
    border: 1px solid #3a3a6a;
    color: #ffffff;
    padding: 6px;
    border-radius: 4px;
    font-size: 0.95em;
    width: 100%;
    box-sizing: border-box;
  }
  .translation-input:focus {
    outline: none;
    border-color: #5a5a8a;
  }
  .senses-label {
    font-size: 0.75em;
    color: #8a8ab0;
    margin-bottom: 2px;
  }
  .senses {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sense-chip {
    background: #222244;
    border: 1px solid #3a3a6a;
    color: #c0c0e0;
    border-radius: 12px;
    padding: 3px 10px;
    font-size: 0.82em;
    cursor: pointer;
  }
  .sense-chip:hover {
    background: #33335a;
    border-color: #5a5a8a;
  }
  .source-badge {
    font-size: 0.72em;
    color: #8888aa;
    background: #111820;
    border-radius: 3px;
    padding: 2px 6px;
    display: inline-block;
    margin-top: 2px;
  }
  .loading {
    font-size: 0.9em;
    color: #8888aa;
    font-style: italic;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 4px;
  }
  .deck-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .deck-label {
    font-size: 0.75em;
    color: #8a8ab0;
    flex-shrink: 0;
  }
  .deck-dots {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .deck-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid transparent;
    padding: 0;
    box-sizing: border-box;
    cursor: pointer;
  }
  .deck-dot.selected {
    border-color: #ffffff;
    box-shadow: 0 0 3px rgba(255,255,255,0.5);
  }
  button {
    background: #2a2a4a;
    border: none;
    color: #ffffff;
    font-size: 0.9em;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 4px;
  }
  button:hover {
    background: #3a3a5a;
  }
  button.primary {
    background: #4a5a9a;
  }
  button.primary:hover {
    background: #5a6aaa;
  }
  button:focus-visible,
  .translation-input:focus-visible {
    outline: 2px solid #6b8aff;
    outline-offset: 2px;
  }
  .spark-reward {
    position: absolute;
    right: 12px;
    bottom: 12px;
    color: #4ade80;
    font-weight: 700;
    font-size: 15px;
    pointer-events: none;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    animation: cxt-spark-float 1.1s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }
  @keyframes cxt-spark-float {
    0%   { opacity: 0; transform: translateY(6px) scale(0.5); }
    35%  { opacity: 1; transform: translateY(-2px) scale(1.25); }
    55%  { transform: translateY(-4px) scale(0.95); }
    100% { opacity: 0; transform: translateY(-30px) scale(1); }
  }
  .spark-burst {
    position: absolute;
    right: 20px;
    bottom: 16px;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .spark-ember {
    position: absolute;
    left: 0;
    top: 0;
    border-radius: 50%;
    animation: cxt-ember-fly 0.85s ease-out forwards;
  }
  @keyframes cxt-ember-fly {
    0%   { opacity: 1; transform: translate(-50%, -50%) translate(0, 0) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -50%) translate(var(--dx), var(--dy)) scale(0.3); }
  }
  @keyframes cxt-spark-fade { 0% { opacity: 0 } 20% { opacity: 1 } 100% { opacity: 0 } }
  @media (prefers-reduced-motion: reduce) {
    .spark-reward { animation: cxt-spark-fade 1s ease-out forwards; }
    .spark-ember { display: none; }
  }
`

export function initDictionary() {
  document.addEventListener('mousedown', handleClickOutside, { capture: true })
}

function hidePopover() {
  host?.remove()
  host = null
  shadow = null
}

// Brief, dismissible on-page hint (its own shadow-DOM host so page CSS can't
// bleed in) for cases where the popover can't open — e.g. selection too long.
const TOAST_CSS = `
  :host { all: initial; }
  .cxt-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    background: #1a1a2e;
    border: 1px solid #3a3a6a;
    border-radius: 10px;
    padding: 10px 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    font-size: 13px;
    color: #c0c0e0;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 90vw;
  }
  .cxt-toast-close {
    background: transparent;
    border: none;
    color: #8888aa;
    font-size: 14px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .cxt-toast-close:hover { color: #ffffff; }
  .cxt-toast-close:focus-visible {
    outline: 2px solid #6b8aff;
    outline-offset: 2px;
  }
`

function showToast(message: string) {
  const toastHost = document.createElement('div')
  toastHost.className = 'cxt-toast-host'
  const toastShadow = toastHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = TOAST_CSS

  const toast = document.createElement('div')
  toast.className = 'cxt-toast'

  const msg = document.createElement('span')
  msg.textContent = message

  const close = document.createElement('button')
  close.className = 'cxt-toast-close'
  close.textContent = '✕'
  close.title = 'Dismiss'
  close.setAttribute('aria-label', 'Dismiss')

  let dismissed = false
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    clearTimeout(timer)
    toastHost.remove()
  }
  close.addEventListener('click', dismiss)

  toast.append(msg, close)
  toastShadow.append(style, toast)
  document.body.appendChild(toastHost)

  const timer = setTimeout(dismiss, 4000)
}

function handleClickOutside(e: MouseEvent) {
  if (!host || !shadow) return
  const popover = shadow.querySelector('.dict-popover')
  if (!popover) return
  const rect = popover.getBoundingClientRect()
  if (
    e.clientX < rect.left || e.clientX > rect.right ||
    e.clientY < rect.top || e.clientY > rect.bottom
  ) {
    hidePopover()
  }
}

export async function showPopoverFromSelection(selectedText?: string, color: BookmarkColor = 'red') {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return

  const word = selectedText ? selectedText.trim() : sel.toString().trim()
  if (!word) return
  if (word.split(/\s+/).length > 10) {
    // Right-click "Save" can still reach here with a long selection (the chip
    // guards this earlier). Show a brief hint instead of failing silently.
    showToast('Selection too long — pick a shorter phrase.')
    return
  }

  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()

  const context = getSelectionContext(word)
  showPopover(word, rect, color, context)
}

async function showPopover(
  word: string,
  rect: DOMRect,
  color: BookmarkColor,
  context: { prefix: string; suffix: string; occurrenceIndex: number; sourceLang?: string } | null
) {
  hidePopover()

  host = document.createElement('div')
  host.className = 'cxt-dict-host'
  shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = DICTIONARY_CSS

  const popover = document.createElement('div')
  popover.className = 'dict-popover'
  const POPUP_WIDTH = 280; // approximate width (250px + padding)
  const MARGIN = 10;

  // Calculate horizontal position to prevent going off-screen
  let left = rect.left;
  if (left + POPUP_WIDTH > window.innerWidth) {
    left = window.innerWidth - POPUP_WIDTH - MARGIN;
  }
  if (left < MARGIN) left = MARGIN;
  popover.style.left = `${left}px`;

  // Default is above the selected text
  let isAbove = true;
  if (rect.top < 250) { // Not enough space above
    // Switch to below if there's more space below or enough space below
    if (window.innerHeight - rect.bottom > rect.top || window.innerHeight - rect.bottom > 250) {
      isAbove = false;
    }
  }

  if (isAbove) {
    popover.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    popover.style.top = 'auto';
  } else {
    popover.style.top = `${rect.bottom + 5}px`;
    popover.style.bottom = 'auto';
  }

  const header = document.createElement('div')
  header.className = 'word-header'
  header.innerHTML = `${word} <span class="phonetics" style="color:#8888aa; font-weight:normal; font-size:0.85em; margin-left:6px"></span>`

  const loading = document.createElement('div')
  loading.className = 'loading'
  loading.textContent = 'Translating...'

  popover.append(header, loading)
  shadow.append(style, popover)
  document.body.appendChild(host)

  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
  const targetLang = settings?.translation?.defaultTargetLanguage || 'en'

  const hasContext = !!(context?.prefix || context?.suffix)
  const sentence = hasContext
    ? ((context?.prefix || '') + word + (context?.suffix || '')).trim()
    : ''

  // Fire both calls in parallel:
  //  - context-aware word translation (background hybrid) → editable field
  //  - full-sentence translation → 💬 context hint (only when context exists)
  const [wordResult, sentenceResult] = await Promise.all([
    chrome.runtime.sendMessage({
      type: 'TRANSLATE_IN_CONTEXT',
      payload: {
        word, sentence, targetLang,
        sourceLang: context?.sourceLang,
        disableAI: settings?.translation?.disableAI ?? true,
        disableGoogleContext: settings?.translation?.disableGoogleContext ?? false,
        disableGoogleSenses: settings?.translation?.disableGoogleSenses ?? false,
      },
    }).catch(() => null) as Promise<ContextTranslateResult | null>,
    sentence ? translate(sentence, targetLang).catch(() => null) : Promise.resolve(null),
  ])

  loading.remove()

  if (wordResult?.phonetics) {
    const span = shadow?.querySelector('.phonetics') as HTMLElement
    if (span) span.textContent = wordResult.phonetics
  }

  // Context hint — shown above the input when a sentence translation is available
  if (sentenceResult?.text) {
    const hint = document.createElement('div')
    hint.className = 'context-hint'
    hint.textContent = `💬 ${sentenceResult.text}`
    popover.append(hint)
  }

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'translation-input'

  // Auto-fill with the context-aware translation; always show dictionary senses as chips.
  const senses = wordResult?.senses ?? []
  if (wordResult?.mode === 'context') {
    input.value = wordResult.translation
  } else {
    input.value = senses[0] ?? 'Failed to translate'
  }

  let sensesRow: HTMLDivElement | null = null
  if (senses.length > 0) {
    sensesRow = document.createElement('div')

    const label = document.createElement('div')
    label.className = 'senses-label'
    label.textContent = 'Choose alternative translation:'

    const chips = document.createElement('div')
    chips.className = 'senses'
    for (const sense of senses) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'sense-chip'
      chip.textContent = sense
      chip.setAttribute('aria-label', `Use translation: ${sense}`)
      chip.onclick = () => {
        input.value = sense
        input.focus()
      }
      chips.append(chip)
    }

    sensesRow.append(label, chips)
  }

  const sourceBadge = document.createElement('span')
  sourceBadge.className = 'source-badge'
  const SOURCE_LABELS: Record<string, string> = {
    'ai+on-device': '🔒 AI · on-device',
    'ai+google': '🤖 AI · Google translate',
    'google-context': '🌐 Google · sentence context',
    'google-senses': '🌐 Google dictionary',
    'google-basic': '🌐 Google translate',
  }
  sourceBadge.textContent = SOURCE_LABELS[wordResult?.source ?? ''] ?? '🌐 Google translate'

  // Deck (color) picker — routes this save to any named deck. Pre-selected to the
  // incoming color (default 'red' from the quick-save chip, or the color chosen
  // from the right-click menu).
  const COLOR_KEYS = Object.keys(BOOKMARK_COLORS) as BookmarkColor[]
  const deckOrder: BookmarkColor[] = settings?.deckOrder?.length === COLOR_KEYS.length
    ? settings.deckOrder
    : COLOR_KEYS
  const deckLabels: Partial<Record<BookmarkColor, string>> = settings?.deckLabels || {}
  let selectedColor: BookmarkColor = color

  const deckRow = document.createElement('div')
  deckRow.className = 'deck-row'
  const deckLabelEl = document.createElement('span')
  deckLabelEl.className = 'deck-label'
  deckLabelEl.textContent = 'Deck'
  const deckDots = document.createElement('div')
  deckDots.className = 'deck-dots'
  const dotEls: Partial<Record<BookmarkColor, HTMLButtonElement>> = {}
  for (const c of deckOrder) {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'deck-dot' + (c === selectedColor ? ' selected' : '')
    dot.style.background = BOOKMARK_COLORS[c]
    const name = deckLabels[c] || (c.charAt(0).toUpperCase() + c.slice(1))
    dot.title = name
    dot.setAttribute('aria-label', `Save to ${name} deck`)
    dot.setAttribute('aria-pressed', String(c === selectedColor))
    dot.onclick = () => {
      selectedColor = c
      for (const key of Object.keys(dotEls) as BookmarkColor[]) {
        const on = key === c
        dotEls[key]!.classList.toggle('selected', on)
        dotEls[key]!.setAttribute('aria-pressed', String(on))
      }
      input.focus()
    }
    dotEls[c] = dot
    deckDots.append(dot)
  }
  deckRow.append(deckLabelEl, deckDots)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.background = 'transparent'
  cancelBtn.style.border = '1px solid #3a3a6a'
  cancelBtn.onclick = hidePopover

  const saveBtn = document.createElement('button')
  saveBtn.className = 'primary'
  saveBtn.textContent = 'Save'

  saveBtn.onclick = async () => {
    saveBtn.textContent = 'Saving...'
    saveBtn.disabled = true

    const item = {
      id: crypto.randomUUID(),
      url: window.location.href,
      text: word,
      phonetics: wordResult?.phonetics || '',
      sourceLang: context?.sourceLang || wordResult?.sourceLang,
      prefix: context?.prefix || '',
      suffix: context?.suffix || '',
      occurrenceIndex: context?.occurrenceIndex || 0,
      color: selectedColor,
      createdAt: Date.now(),
      orphaned: false,
      translation: input.value.trim(),
      nextReview: Date.now(),
      interval: 0,
      ease: 2.5,
      repetitions: 0
    }

    await chrome.runtime.sendMessage({ type: 'SAVE_ITEM', payload: item }).catch(() => { })
    await chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', payload: 'save' }).catch(() => { })
    applyHighlight(item)
    // Pulse the just-saved word on the page to tie the reward to it.
    pulseHighlight(item.id, BOOKMARK_COLORS[selectedColor])

    saveBtn.textContent = 'Saved!'

    // "+N 🔥" reward with a springy pop and a small ember burst — auto-removes
    // after the animation and never blocks the hidePopover timer below.
    const points = settings?.gamification?.pointsPerSave ?? 1
    const spark = document.createElement('div')
    spark.className = 'spark-reward'
    spark.textContent = `+${points} 🔥`
    popover.append(spark)

    const burst = document.createElement('div')
    burst.className = 'spark-burst'
    const EMBER_COLORS = ['#ffd93d', '#ffb36b', '#ff9d3d', '#ff6b3d', '#4ade80']
    const EMBER_COUNT = 10
    for (let i = 0; i < EMBER_COUNT; i++) {
      const ember = document.createElement('span')
      ember.className = 'spark-ember'
      const angle = (i / EMBER_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6
      const dist = 20 + Math.random() * 20
      const size = 4 + Math.round(Math.random() * 3)
      ember.style.width = `${size}px`
      ember.style.height = `${size}px`
      ember.style.background = EMBER_COLORS[i % EMBER_COLORS.length]
      ember.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
      ember.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
      burst.append(ember)
    }
    popover.append(burst)

    setTimeout(() => { spark.remove(); burst.remove() }, 1100)
    setTimeout(hidePopover, 1100)
  }

  actions.append(cancelBtn, saveBtn)
  popover.append(input)
  if (sensesRow) popover.append(sensesRow)
  popover.append(sourceBadge, deckRow, actions)
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveBtn.click()
    }
  })
  input.focus()
}
