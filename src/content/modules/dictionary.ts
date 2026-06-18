import { translate } from './translation'
import { getSelectionContext, applyHighlight } from './anchor'
import { BookmarkColor } from '../../shared/types'

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
`

export function initDictionary() {
  document.addEventListener('mousedown', handleClickOutside)
}

function hidePopover() {
  host?.remove()
  host = null
  shadow = null
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
  if (!word || word.split(/\s+/).length > 10) return // Allow up to 10 words for dictionary phrases

  const range = sel.getRangeAt(0)
  const rect = range.getBoundingClientRect()

  // Capture context BEFORE selection is lost
  const context = getSelectionContext(word)
  showPopover(word, rect, color, context)
}

async function showPopover(
  word: string,
  rect: DOMRect,
  color: BookmarkColor,
  context: { prefix: string; suffix: string; occurrenceIndex: number } | null
) {
  hidePopover()

  host = document.createElement('div')
  host.className = 'cxt-dict-host'
  shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = DICTIONARY_CSS

  const popover = document.createElement('div')
  popover.className = 'dict-popover'
  popover.style.left = `${rect.left}px`
  if (rect.top > 250) {
    popover.style.bottom = `${window.innerHeight - rect.top + 5}px`
    popover.style.top = 'auto'
  } else {
    popover.style.top = `${rect.bottom + 5}px`
    popover.style.bottom = 'auto'
  }

  // Fetch phonetics from Dictionary API
  let phonetics = ''
  try {
    const words = word.split(/\s+/)
    const phoneticsPromises = words.map(async (w) => {
      let cleanWord = w.replace(/^[^\w]+|[^\w]+$/g, '') // Remove leading/trailing punctuation
      cleanWord = cleanWord.replace(/['’]s$/i, '') // Remove trailing 's to help API find the base word
      if (!cleanWord) return ''
      try {
        const pRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanWord)}`)
        if (pRes.ok) {
          const pData = await pRes.json()
          return pData[0]?.phonetics?.find((p: any) => p.text)?.text || pData[0]?.phonetic || ''
        }
      } catch {
        // ignore
      }
      return ''
    })

    const results = await Promise.all(phoneticsPromises)
    phonetics = results.filter(Boolean).join(' ')
  } catch {
    // Ignore phonetics failure
  }

  const header = document.createElement('div')
  header.className = 'word-header'
  header.innerHTML = `${word} <span style="color:#8888aa; font-weight:normal; font-size:0.85em; margin-left:6px">${phonetics}</span>`

  const loading = document.createElement('div')
  loading.className = 'loading'
  loading.textContent = 'Translating...'

  popover.append(header, loading)
  shadow.append(style, popover)
  document.body.appendChild(host)

  // Fetch settings to get target language
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
  const targetLang = settings?.translation?.defaultTargetLanguage || 'en'

  let translatedText = ''
  try {
    const res = await translate(word, targetLang)
    translatedText = res.text
  } catch {
    translatedText = 'Failed to translate'
  }

  loading.remove()

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'translation-input'
  input.value = translatedText

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
      phonetics,
      prefix: context?.prefix || '',
      suffix: context?.suffix || '',
      occurrenceIndex: context?.occurrenceIndex || 0,
      color, // Passed in from the context menu (or defaults to red)
      createdAt: Date.now(),
      orphaned: false,
      translation: input.value.trim(),
      nextReview: Date.now(),
      interval: 0,
      ease: 2.5,
      repetitions: 0
    }

    // Send to background to save
    await chrome.runtime.sendMessage({
      type: 'SAVE_ITEM',
      payload: item
    }).catch(() => { })

    await chrome.runtime.sendMessage({ type: 'LOG_ACTIVITY', payload: 'save' }).catch(() => { })

    // Highlight the newly saved item
    applyHighlight(item)

    saveBtn.textContent = 'Saved!'
    setTimeout(hidePopover, 1000)
  }

  actions.append(cancelBtn, saveBtn)
  popover.append(input, actions)

  // Focus the input but don't select all text unless the user wants to
  input.focus()
}
