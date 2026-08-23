import React, { useState, useEffect, useRef, useCallback } from 'react';
import { translate } from '../modules/translation';
import { Settings } from '../../shared/types';

type Props = {
  text: string;
  isLoading: boolean;
  progress: number;
  status: string;
  cropBox?: { x: number; y: number; width: number; height: number } | null;
  ocrLang?: string;
  onClose: () => void;
  onRecrop: () => void;
};

export const FloatingTextPopup: React.FC<Props> = ({ text, isLoading, progress, status, cropBox, ocrLang, onClose, onRecrop }) => {
  const ocrLangMap: Record<string, string> = {
    eng: 'EN',
    chi_sim: 'ZH-S',
    chi_tra: 'ZH-T',
    jpn: 'JA',
    kor: 'KO',
    vie: 'VI',
    fra: 'FR',
    spa: 'ES',
    deu: 'DE',
    ita: 'IT',
    rus: 'RU'
  };
  const ocrToBcp47Map: Record<string, string> = {
    'chi_sim': 'zh-CN', 'chi_tra': 'zh-TW', 'jpn': 'ja', 'kor': 'ko',
    'vie': 'vi', 'fra': 'fr', 'spa': 'es', 'deu': 'de', 'ita': 'it', 'rus': 'ru', 'eng': 'en'
  };
  const ocrFullNameMap: Record<string, string> = {
    eng: 'English',
    chi_sim: 'Chinese (Simplified)',
    chi_tra: 'Chinese (Traditional)',
    jpn: 'Japanese',
    kor: 'Korean',
    vie: 'Vietnamese',
    fra: 'French',
    spa: 'Spanish',
    deu: 'German',
    ita: 'Italian',
    rus: 'Russian'
  };
  const displayLang = ocrLang ? (ocrLangMap[ocrLang] || ocrLang.toUpperCase()) : '';
  const fullNameLang = ocrLang ? (ocrFullNameMap[ocrLang] || ocrLang) : '';
  const targetLang = (ocrLang && ocrToBcp47Map[ocrLang]) || 'en';
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [translatedText, setTranslatedText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const translatedRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedMiniPlayerRef = useRef(false);
  // Guards against out-of-order responses: if the text changes again (new edit,
  // or Retry) before an in-flight translate() resolves, a later request's result
  // could otherwise be overwritten by an earlier, slower one finishing after it.
  const translateRequestIdRef = useRef(0);

  // Shared translate call used by the initial effect, the debounced input
  // handler, and the Retry affordance — so a failed attempt can be re-run.
  const runTranslation = useCallback((rawText: string) => {
    const currentText = rawText.trim();
    const requestId = ++translateRequestIdRef.current;
    if (!currentText) {
      setTranslatedText('');
      return;
    }
    setTranslatedText('⏳ Translating...');

    const fail = (err: unknown) => {
      if (requestId !== translateRequestIdRef.current) return; // superseded
      console.error('Translation error:', err);
      setTranslatedText('⚠ Translation failed');
    };

    // chrome.runtime.sendMessage throws SYNCHRONOUSLY (not a rejected
    // promise) when the extension context is invalidated — e.g. the
    // extension was reloaded/updated while this tab's content script is
    // still the old instance. Called bare, that throw aborts this function
    // right after "⏳ Translating..." is set above, before .then()/.catch()
    // ever gets attached — nothing is left to ever change that state again.
    let settingsPromise: Promise<Settings>;
    try {
      settingsPromise = chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    } catch (err) {
      fail(err);
      return;
    }

    settingsPromise
      .then((settings: Settings) => {
        const tgtLang = settings?.translation?.defaultTargetLanguage || 'en';
        return translate(currentText, tgtLang);
      })
      .then(res => {
        if (requestId !== translateRequestIdRef.current) return; // superseded
        setTranslatedText(res.text);
      })
      .catch(fail);
  }, []);

  const retryTranslation = useCallback(() => {
    const currentText = textRef.current?.innerText || textRef.current?.textContent || text;
    runTranslation(currentText);
  }, [runTranslation, text]);

  // Written imperatively (like textRef's OCR text above) instead of through
  // JSX interpolation. On some hosting pages, React's own commit for this
  // element's re-render silently never reaches the DOM — setTranslatedText
  // runs with the correct value (confirmed via logging) but the text
  // visually stays frozen on "Translating...". A direct DOM write bypasses
  // whatever is swallowing React's commit here.
  useEffect(() => {
    const el = translatedRef.current;
    if (!el) return;
    if (!translatedText) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const isWarning = translatedText.startsWith('⚠');
    const isPending = translatedText.startsWith('⏳');
    el.style.display = 'block';
    el.style.color = isWarning ? '#ff6b6b' : isPending ? '#8888aa' : '#6bcfff';
    el.style.borderLeft = `2px solid ${isWarning ? '#aa3333' : isPending ? '#3a3a5a' : '#2a3a5a'}`;
    el.style.fontStyle = isPending ? 'italic' : 'normal';
    el.textContent = translatedText;

    if (isWarning) {
      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry';
      retryBtn.style.cssText = 'background:none;border:none;color:#6bcfff;cursor:pointer;font-size:1em;padding:0;margin-left:8px;text-decoration:underline';
      retryBtn.onclick = retryTranslation;
      el.appendChild(retryBtn);
    }
  }, [translatedText, retryTranslation]);

  useEffect(() => {
    if (textRef.current && !isLoading) {
      if (text) {
        textRef.current.textContent = text;
        runTranslation(text);
      } else {
        textRef.current.innerHTML = '<span style="color:#888" contenteditable="false">No text recognized.</span>';
        setTranslatedText('');
      }
    }
  }, [text, isLoading, runTranslation]);

  const handleInput = () => {
    if (translateTimerRef.current) {
      clearTimeout(translateTimerRef.current);
    }
    translateTimerRef.current = setTimeout(() => {
      const currentText = textRef.current?.innerText || textRef.current?.textContent || '';
      runTranslation(currentText);
    }, 1000);
  };

  // Cleanup the debounce timer on unmount so it can't fire setState after the
  // popup has closed (e.g. user closes within 1s of typing).
  useEffect(() => {
    return () => {
      if (translateTimerRef.current) {
        clearTimeout(translateTimerRef.current);
      }
    };
  }, []);

  // NOTE (D17): This uses window.speechSynthesis directly instead of routing
  // through chrome.tts to avoid conflicts with the mini-player's backend
  // session (both APIs share the same underlying TTS engine slot on Chromium).
  // To prevent interruption: pause the mini-player before speaking, resume when
  // the OCR utterance completes, using the background's CONTROL_READ_ALOUD pause/resume
  // actions. To keep voice/speed consistent we resolve rate/pitch/volume/voice
  // from settings.readAloud (mirroring the background resolver).
  const handleReadAloud = async () => {
    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      // Resume mini-player if it was playing when we started OCR speech
      if (pausedMiniPlayerRef.current) {
        chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => { })
        pausedMiniPlayerRef.current = false
      }
      return;
    }

    const currentText = textRef.current?.innerText || textRef.current?.textContent || text;
    if (!currentText) return;

    try {
      // Pause mini-player before speaking OCR text, and remember if it was playing
      const pauseResult = await chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'pause' } })
      pausedMiniPlayerRef.current = pauseResult?.wasPlaying === true

      const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const utterance = new SpeechSynthesisUtterance(currentText);
      utterance.lang = targetLang;

      if (settings?.readAloud) {
        utterance.rate = settings.readAloud.speed || 1;
        utterance.pitch = settings.readAloud.pitch || 1;
        utterance.volume = settings.readAloud.volume || 1;

        let resolvedVoiceName = settings.readAloud.voice || undefined;
        if (settings.readAloud.languageVoices) {
          const exactMatch = settings.readAloud.languageVoices[targetLang];
          if (exactMatch) {
            resolvedVoiceName = exactMatch;
          } else {
            const shortLang = targetLang.split('-')[0];
            const prefixMatch = Object.entries(settings.readAloud.languageVoices).find(([k]) => k.startsWith(shortLang) || shortLang.startsWith(k));
            if (prefixMatch) {
              resolvedVoiceName = prefixMatch[1];
            }
          }
        }

        if (resolvedVoiceName) {
          const voices = window.speechSynthesis.getVoices();
          const voice = voices.find(v => v.name === resolvedVoiceName);
          if (voice) utterance.voice = voice;
        }
      }
      utterance.onend = () => {
        setIsPlaying(false);
        // Resume mini-player when OCR speech completes
        if (pausedMiniPlayerRef.current) {
          chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => { })
          pausedMiniPlayerRef.current = false
        }
      };
      utterance.onerror = () => {
        setIsPlaying(false);
        // Resume mini-player if OCR speech errors
        if (pausedMiniPlayerRef.current) {
          chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => { })
          pausedMiniPlayerRef.current = false
        }
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      setIsPlaying(true);
    } catch (err) {
      console.error('Failed to read aloud', err);
      // Resume mini-player on exception
      if (pausedMiniPlayerRef.current) {
        chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => { })
        pausedMiniPlayerRef.current = false
      }
    }
  };

  // Closing this popup (or starting a new OCR session, which unmounts and
  // remounts it) while OCR read-aloud is speaking otherwise leaves the
  // utterance running with nothing left to stop it, and — worse — leaves the
  // mini-player paused forever, since resuming it only happens in onend/
  // onerror/the toggle-off click, none of which fire on unmount.
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
      if (pausedMiniPlayerRef.current) {
        chrome.runtime.sendMessage({ type: 'CONTROL_READ_ALOUD', payload: { action: 'resume' } }).catch(() => { })
        pausedMiniPlayerRef.current = false;
      }
    };
  }, []);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Element;
      // Ignore if clicking inside the popup
      if (popupRef.current && popupRef.current.contains(target)) return;
      // Ignore clicks inside the dictionary popover, tooltip, or the save chip
      if (target.closest('.cxt-dict-host') || target.closest('.cxt-delete-tooltip') || target.closest('.cxt-selchip-host')) return;

      onClose();
    };

    window.addEventListener('mousedown', handleOutsideClick, { capture: true });
    return () => window.removeEventListener('mousedown', handleOutsideClick, { capture: true });
  }, [onClose]);

  useEffect(() => {
    const POPUP_WIDTH = 340; // width + margin
    const MARGIN = 20;

    if (cropBox) {
      // Try right side first
      let x = cropBox.x + cropBox.width + MARGIN;
      let y = cropBox.y;

      // If not enough space on the right, try the left
      if (x + POPUP_WIDTH > window.innerWidth) {
        x = cropBox.x - POPUP_WIDTH - MARGIN;

        // If not enough space on the left either, put it below
        if (x < MARGIN) {
          x = Math.max(MARGIN, cropBox.x + cropBox.width / 2 - POPUP_WIDTH / 2);
          y = cropBox.y + cropBox.height + MARGIN;

          // If not enough space below, put it above
          if (y + 150 > window.innerHeight) {
            y = Math.max(MARGIN, cropBox.y - 150 - MARGIN);
          }
        }
      }

      // Ensure it doesn't go off screen
      x = Math.max(MARGIN, Math.min(x, window.innerWidth - POPUP_WIDTH));
      y = Math.max(MARGIN, Math.min(y, window.innerHeight - 150));

      setPosition({ x, y });
    } else {
      // Fallback if no cropBox
      let x = window.innerWidth - POPUP_WIDTH - MARGIN;
      if (x < MARGIN) x = MARGIN;
      const y = Math.max(MARGIN, window.innerHeight / 2 - 150);
      setPosition({ x, y });
    }
  }, [cropBox]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only drag on the header
    if ((e.target as HTMLElement).closest('.drag-handle')) {
      setIsDragging(true);
      dragStart.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y
      };
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (isDragging && popupRef.current) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const scrollbarHeight = window.innerHeight - document.documentElement.clientHeight;
      const rect = popupRef.current.getBoundingClientRect();
      const maxX = Math.floor(Math.max(0, (window.innerWidth - scrollbarWidth) - rect.width));
      const maxY = Math.floor(Math.max(0, (window.innerHeight - scrollbarHeight) - rect.height));
      const newX = Math.round(Math.min(Math.max(e.clientX - dragStart.current.x, 0), maxX));
      const newY = Math.round(Math.min(Math.max(e.clientY - dragStart.current.y, 0), maxY));
      setPosition({
        x: newX,
        y: newY
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove, { capture: true });
      window.addEventListener('mouseup', handleMouseUp, { capture: true });
    } else {
      window.removeEventListener('mousemove', handleMouseMove, { capture: true });
      window.removeEventListener('mouseup', handleMouseUp, { capture: true });
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove, { capture: true });
      window.removeEventListener('mouseup', handleMouseUp, { capture: true });
    };
  }, [isDragging]);

  return (
    <div
      ref={popupRef}
      className="cxt-ocr-popup"
      lang={targetLang}
      onMouseDown={handleMouseDown}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: 320,
        backgroundColor: '#1a1a2e',
        border: '1px solid #3a3a6a',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        color: '#fff',
        fontFamily: 'system-ui, sans-serif',
        zIndex: 99,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <style>{`
        .cxt-ocr-popup button:focus-visible,
        .cxt-ocr-popup [contenteditable]:focus-visible {
          outline: 2px solid #6bcfff;
          outline-offset: 2px;
        }
      `}</style>
      <div
        className="drag-handle"
        style={{
          padding: '8px 12px',
          backgroundColor: '#2a2a4e',
          borderBottom: '1px solid #3a3a6a',
          cursor: isDragging ? 'grabbing' : 'grab',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          userSelect: 'none'
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 'bold', color: '#aab', display: 'flex', alignItems: 'center', gap: '6px' }}>
          Text from Image
          {displayLang && (
            <span
              title={`Detected language: ${fullNameLang}\n\nNote: If this doesn't match the actual language in the image, the recognized text will be inaccurate or gibberish.\nYou can change this in the Settings page.`}
              style={{ fontSize: 9, fontWeight: 700, background: '#3a3a6a', color: '#4ade80', padding: '2px 5px', borderRadius: 4, lineHeight: 1, whiteSpace: 'nowrap', cursor: 'help' }}
            >
              {displayLang}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={handleReadAloud}
            title="Read Aloud"
            aria-label={isPlaying ? 'Stop reading aloud' : 'Read aloud'}
            style={{
              background: 'none',
              border: 'none',
              color: isPlaying ? '#6bcfff' : '#aab',
              cursor: 'pointer',
              fontSize: 16,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            {isPlaying ? '⏹' : '🔊'}
          </button>
          <button
            onClick={onRecrop}
            title="Re-crop"
            aria-label="Crop a new area from the image"
            style={{
              background: 'none',
              border: 'none',
              color: '#aab',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
          </button>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close extracted text"
            style={{
              background: 'none',
              border: 'none',
              color: '#aab',
              cursor: 'pointer',
              fontSize: 16,
              padding: 0,
              lineHeight: 1
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ padding: 16, fontSize: 16, lineHeight: 1.5, minHeight: 60, maxHeight: '60vh', overflowY: 'auto', wordBreak: 'break-word' }}>
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: '#88a' }}>
            <div style={{ fontSize: 13 }}>{status || 'Recognizing text...'}</div>
            <div style={{ width: '100%', height: 4, backgroundColor: '#2a2a4e', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(5, progress * 100)}%`, height: '100%', backgroundColor: '#6bcfff', transition: 'width 0.2s' }} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div
              ref={textRef}
              contentEditable={true}
              suppressContentEditableWarning
              onInput={handleInput}
              style={{ outline: 'none', cursor: 'text', width: '100%', whiteSpace: 'pre-wrap' }}
            />
            <div
              ref={translatedRef}
              style={{
                display: 'none',
                fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif",
                fontSize: '0.875em',
                padding: '3px 0 5px 10px',
                lineHeight: 1.6
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
