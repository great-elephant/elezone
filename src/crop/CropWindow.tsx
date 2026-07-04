import { useState, useEffect, useRef } from 'react'
import { FloatingTextPopup } from '../content/components/FloatingTextPopup'

type State = 'loading' | 'cropping' | 'processing' | 'done'
type Rect = { x: number; y: number; width: number; height: number }

// Same high-contrast crosshair used by the in-page crop overlay.
const crosshair = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Cpath stroke='%23000000' stroke-width='6' stroke-linecap='round' d='M24 8v32M8 24h32'/%3E%3Cpath stroke='%23ffffff' stroke-width='2' stroke-linecap='round' d='M24 8v32M8 24h32'/%3E%3C/svg%3E") 24 24, crosshair`

// Standalone OCR surface for pages where the content script can't run (Chrome's
// PDF viewer, chrome:// pages, ...). The background captures a screenshot and
// opens this window; the user crops on the screenshot and OCR runs as usual,
// with results routed back via runtime broadcast (OCR_WINDOW_*).
export function CropWindow() {
  const [state, setState] = useState<State>('loading')
  const [dataUrl, setDataUrl] = useState('')
  const [lang, setLang] = useState('eng')
  const [ocrText, setOcrText] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [cropBox, setCropBox] = useState<Rect | null>(null)
  const [sel, setSel] = useState<Rect | null>(null)

  const imgRef = useRef<HTMLImageElement>(null)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  // Load the screenshot handed off by the background.
  useEffect(() => {
    chrome.storage.session.get('ocr_window_payload')
      .then(res => {
        const p = res.ocr_window_payload as { dataUrl?: string; lang?: string } | undefined
        if (p?.dataUrl) {
          setDataUrl(p.dataUrl)
          setLang(p.lang || 'eng')
          setState('cropping')
        } else {
          window.close()
        }
      })
      .catch(() => window.close())
  }, [])

  // Receive OCR progress/result routed from the background.
  useEffect(() => {
    const handler = (msg: { type?: string; payload?: { status?: string; progress?: number; text?: string; error?: string } }) => {
      if (msg.type === 'OCR_WINDOW_PROGRESS') {
        setStatus(msg.payload?.status || '')
        setProgress(msg.payload?.progress ?? 0)
      } else if (msg.type === 'OCR_WINDOW_RESULT') {
        setOcrText(msg.payload?.error ? 'Error recognizing text.' : (msg.payload?.text || ''))
        setState('done')
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') window.close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function onMouseDown(e: React.MouseEvent) {
    if (state !== 'cropping') return
    dragStart.current = { x: e.clientX, y: e.clientY }
    setSel({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
  }

  function onMouseMove(e: React.MouseEvent) {
    const s = dragStart.current
    if (!s) return
    setSel({
      x: Math.min(s.x, e.clientX),
      y: Math.min(s.y, e.clientY),
      width: Math.abs(e.clientX - s.x),
      height: Math.abs(e.clientY - s.y),
    })
  }

  function onMouseUp(e: React.MouseEvent) {
    const s = dragStart.current
    if (!s) return
    dragStart.current = null
    const x = Math.min(s.x, e.clientX)
    const y = Math.min(s.y, e.clientY)
    const width = Math.abs(e.clientX - s.x)
    const height = Math.abs(e.clientY - s.y)
    setSel(null)

    const img = imgRef.current
    if (width < 8 || height < 8 || !img) return

    // Map the on-screen selection to the screenshot's natural pixels.
    const rect = img.getBoundingClientRect()
    const scaleX = img.naturalWidth / rect.width
    const scaleY = img.naturalHeight / rect.height
    const sw = width * scaleX
    const sh = height * scaleY

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw))
    canvas.height = Math.max(1, Math.round(sh))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, (x - rect.left) * scaleX, (y - rect.top) * scaleY, sw, sh, 0, 0, canvas.width, canvas.height)
    const cropped = canvas.toDataURL('image/png')

    setCropBox({ x, y, width, height })
    setProgress(0)
    setStatus('Reading text from image...')
    setState('processing')
    chrome.runtime.sendMessage({
      type: 'FORWARD_RECOGNIZE_TEXT',
      payload: { imageBase64: cropped, lang, broadcast: true },
    }).catch(() => {})
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#111', overflow: 'hidden', cursor: state === 'cropping' ? crosshair : 'default' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {dataUrl && (
        // Fill the window exactly (independent x/y scale factors below still map
        // clicks to the right source pixels) so a screenshot whose aspect ratio
        // doesn't perfectly match the popup's viewport never forces a scrollbar.
        <img ref={imgRef} src={dataUrl} draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'fill', userSelect: 'none' }} />
      )}

      {sel && state === 'cropping' && (
        <div style={{ position: 'fixed', left: sel.x, top: sel.y, width: sel.width, height: sel.height, border: '2px dashed #fff', outline: '2px dashed #000', boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
      )}

      {state === 'cropping' && !sel && (
        <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '8px 16px', borderRadius: 6, fontSize: 13, pointerEvents: 'none' }}>
          Drag to select text area · Esc to close
        </div>
      )}

      {(state === 'processing' || state === 'done') && (
        <FloatingTextPopup
          text={ocrText}
          isLoading={state === 'processing'}
          progress={progress}
          status={status}
          cropBox={cropBox}
          ocrLang={lang}
          onClose={() => window.close()}
        />
      )}
    </div>
  )
}
