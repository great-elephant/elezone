import React, { useState, useEffect, useRef } from 'react';
import { CropOverlay } from './CropOverlay';
import { FloatingTextPopup } from './FloatingTextPopup';

import { Settings } from '../../shared/types';

type State = 'idle' | 'capturing' | 'cropping' | 'processing' | 'done';

// Crop a data URL to `cropWidth` x `cropHeight` CSS pixels starting at
// (offsetX, offsetY), scaling by the image's own resolution so it works
// regardless of devicePixelRatio. Returns null on any decode failure.
function cropImage(dataUrl: string, offsetX: number, offsetY: number, cropWidth: number, cropHeight: number): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / window.innerWidth;
      const sx = Math.round(offsetX * ratio);
      const sy = Math.round(offsetY * ratio);
      const w = Math.max(1, Math.round(cropWidth * ratio));
      const h = Math.max(1, Math.round(cropHeight * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Blocks scroll input (wheel/touch/keys) at the window level without
// touching overflow/CSS, so the scrollbar keeps looking and behaving like
// normal — just no navigation happens while it's engaged. Applied directly
// (not via a React effect keyed off state) so it engages in the very same
// tick the START_CROP_MODE message arrives, rather than waiting a render +
// effect-commit cycle — that gap was enough for a wheel tick already in
// flight (e.g. mid-scroll when Alt+O was pressed) to slip through.
//
// wheel/touchmove/keydown cover the common input methods, but dragging the
// scrollbar thumb itself (or clicking its track) scrolls via the browser's
// native UI compositor — it never fires a cancelable event a content script
// can preventDefault. The 'scroll' event does fire for it (just already
// after the fact, and non-cancelable), so as a catch-all, snap straight back
// to the locked position the instant it moves. That's what actually keeps
// the scrollbar draggable-looking but non-functional while still visible.
let scrollLocked = false;
let lockedScrollX = 0;
let lockedScrollY = 0;
function blockWheel(e: Event) { e.preventDefault(); }
function blockScrollKeys(e: KeyboardEvent) {
  const scrollKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '];
  if (scrollKeys.includes(e.key)) e.preventDefault();
}
function snapBack() {
  if (window.scrollX !== lockedScrollX || window.scrollY !== lockedScrollY) {
    window.scrollTo(lockedScrollX, lockedScrollY);
  }
}
function lockScroll(): void {
  if (scrollLocked) return;
  scrollLocked = true;
  lockedScrollX = window.scrollX;
  lockedScrollY = window.scrollY;
  window.addEventListener('wheel', blockWheel, { passive: false, capture: true });
  window.addEventListener('touchmove', blockWheel, { passive: false, capture: true });
  window.addEventListener('keydown', blockScrollKeys, { capture: true });
  window.addEventListener('scroll', snapBack, { passive: true, capture: true });
}
function unlockScroll(): void {
  if (!scrollLocked) return;
  scrollLocked = false;
  window.removeEventListener('wheel', blockWheel, { capture: true });
  window.removeEventListener('touchmove', blockWheel, { capture: true });
  window.removeEventListener('keydown', blockScrollKeys, { capture: true });
  window.removeEventListener('scroll', snapBack, { capture: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Waits until the browser has actually painted, not just until React has
// committed. One rAF only guarantees "before the next paint" — it can still
// fire before that paint happens. Two back-to-back rAFs guarantee a full
// paint has already occurred by the time the callback runs.
function nextPaint(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

// chrome.tabs.captureVisibleTab enforces a per-second quota (MAX_CAPTURE_
// VISIBLE_TAB_CALLS_PER_SECOND) — retriggering OCR again shortly after a
// previous capture (e.g. a fast repeated Alt+O/click) can get rejected with
// that quota error. Retry once past the window instead of silently landing
// on a blank idle state that looks like the trigger did nothing.
async function captureVisibleTab(): Promise<{ dataUrl?: string; error?: string }> {
  const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }) as { dataUrl?: string; error?: string } | undefined;
  if (response?.dataUrl || !response?.error) return response ?? {};
  await sleep(1100);
  return (await chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' })) ?? {};
}

// chrome.tabs.captureVisibleTab captures the raw tab surface, scrollbar and
// all, which then gets frozen into the crop overlay's background — a visible
// mismatch against the "frozen" look we want. Rather than hiding the live
// scrollbar before capturing (which reflows the whole page for a frame — on
// a complex site like YouTube that's a visible jank, not worth it), just
// capture as-is and trim the scrollbar's strip off the image afterwards. The
// live page and its scrollbar are never touched.
async function captureAndTrimScrollbar(): Promise<{ dataUrl?: string } | undefined> {
  const response = await captureVisibleTab();
  if (!response?.dataUrl) return response;

  const html = document.documentElement;
  const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
  const scrollbarHeight = Math.max(0, window.innerHeight - html.clientHeight);
  if (scrollbarWidth === 0 && scrollbarHeight === 0) return response;

  // RTL pages put the vertical scrollbar on the left instead — cropping the
  // right edge there would cut off real content and leave the scrollbar in.
  const isRtl = getComputedStyle(html).direction === 'rtl';
  const offsetX = isRtl ? scrollbarWidth : 0;
  const cropWidth = window.innerWidth - scrollbarWidth;
  const cropHeight = window.innerHeight - scrollbarHeight;

  const trimmed = await cropImage(response.dataUrl, offsetX, 0, cropWidth, cropHeight);
  return trimmed ? { dataUrl: trimmed } : response;
}

export const OcrManager: React.FC = () => {
  const [state, setState] = useState<State>('idle');
  const [screenshot, setScreenshot] = useState<string>('');
  const [ocrText, setOcrText] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [cropBox, setCropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const settingsRef = useRef<Settings | undefined>(undefined);
  // Every trigger_ocr (Alt+O, context menu, popup button) starts a brand new
  // session, discarding whatever was open. Bump this on each START_CROP_MODE
  // so async work from an abandoned session (an in-flight capture, or an
  // OCR_PROGRESS/OCR_COMPLETE for a crop the user already replaced) can tell
  // it's stale and no-op instead of clobbering the new session's state.
  const sessionIdRef = useRef(0);

  useEffect(() => {
    const handleMessage = (msg: any) => {
      if (msg.type === 'START_CROP_MODE') {
        // Lock first, synchronously, before anything else — see lockScroll's
        // comment for why this can't wait on a React state/effect round-trip.
        lockScroll();
        // Always reset and start fresh — a second Alt+O while OCR is already
        // open replaces it with a brand new capture rather than just closing.
        const sessionId = ++sessionIdRef.current;
        setOcrText('');
        setState('capturing');
        // Wait for the browser to actually paint away whatever was on screen
        // before this session (e.g. a previous OCR Result popup) — otherwise
        // chrome.tabs.captureVisibleTab can capture a stale frame that still
        // has the old popup baked into its pixels, even though it's already
        // gone from the DOM. The frozen "old result" the user sees afterwards
        // is then just a picture, not a stuck live element.
        nextPaint()
          .then(() => captureAndTrimScrollbar())
          .then((response) => {
            if (sessionId !== sessionIdRef.current) return; // superseded meanwhile
            if (response?.dataUrl) {
              setScreenshot(response.dataUrl);
              setState('cropping');
            } else {
              unlockScroll();
              setState('idle');
            }
          })
          .catch(err => {
            if (sessionId !== sessionIdRef.current) return;
            console.error('Failed to capture tab:', err);
            unlockScroll();
            setState('idle');
          });
      } else if (msg.type === 'OCR_PROGRESS') {
        if (msg.payload.requestId !== sessionIdRef.current) return; // stale session
        setStatus(msg.payload.status);
        setProgress(msg.payload.progress ?? 0);
      } else if (msg.type === 'OCR_COMPLETE') {
        // A later Alt+O already replaced this session — drop the late result
        // instead of popping a stale popup back up.
        if (msg.payload.requestId !== sessionIdRef.current) return;
        // Final result arrives via tab message (fire-and-forget pattern)
        const { text, error } = msg.payload as { text?: string; error?: string };
        if (error) {
          console.error('OCR Error:', error);
          setOcrText('Error recognizing text.');
        } else {
          let result = text || '';
          const ocr = settingsRef.current?.ocr;
          if (ocr) {
            if (ocr.removeExtraSpaces) result = result.replace(/\s+/g, ' ').trim();
            if (ocr.sentenceCase) {
              result = result.toLowerCase()
                .replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, prefix, char) => prefix + char.toUpperCase())
                .replace(/\b(i)([''](m|ll|d|ve))?\b/g, (_, _i, suffix) => 'I' + (suffix || ''));
            }
          }
          setOcrText(result);
        }
        setState('done');
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  // Unmounting mid-session (e.g. a hard SPA nav tearing down the content
  // script) would otherwise leave scroll locked forever with no OcrManager
  // left to unlock it.
  useEffect(() => () => unlockScroll(), []);

  const handleCropComplete = async (croppedDataUrl: string, rect: { x: number; y: number; width: number; height: number }) => {
    // The frozen screenshot is gone as of here — FloatingTextPopup is just a
    // small popup over the live, scrollable page, so unlock immediately
    // rather than waiting for OCR to finish or the result popup to close.
    unlockScroll();
    setState('processing');
    setCropBox(rect);
    setProgress(0);
    setStatus('Initializing OCR...');

    try {
      let settings: Settings | undefined;
      try {
        settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        settingsRef.current = settings;
      } catch (e) {
        console.error('Failed to get settings for OCR', e);
      }

      const lang = settings?.ocr?.language || 'chi_sim';

      // Fire-and-forget: background immediately acks, result comes back via OCR_COMPLETE message.
      // requestId lets us drop this result later if a fresh Alt+O replaces the session first.
      chrome.runtime.sendMessage({
        type: 'FORWARD_RECOGNIZE_TEXT',
        payload: { imageBase64: croppedDataUrl, lang, requestId: sessionIdRef.current }
      }).catch(() => {/* background ack can fail safely */});

    } catch (err) {
      console.error('OCR Error:', err);
      setOcrText('Error recognizing text.');
      setState('done');
    }
  };

  const handleCancelCrop = () => {
    unlockScroll();
    setState('idle');
  };

  const handleClosePopup = () => {
    setState('idle');
    setOcrText('');
  };

  if (state === 'idle') return null;

  return (
    <>
      {state === 'cropping' && (
        <CropOverlay
          screenshotDataUrl={screenshot}
          onCropComplete={handleCropComplete}
          onCancel={handleCancelCrop}
        />
      )}
      {(state === 'processing' || state === 'done') && (
        <FloatingTextPopup
          text={ocrText}
          isLoading={state === 'processing'}
          progress={progress}
          status={status}
          cropBox={cropBox}
          ocrLang={settingsRef.current?.ocr?.language}
          onClose={handleClosePopup}
        />
      )}
    </>
  );
};
