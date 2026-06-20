import React, { useState, useEffect, useRef } from 'react';
import { translate } from '../modules/translation';
import { Settings } from '../../shared/types';

type Props = {
  text: string;
  isLoading: boolean;
  progress: number;
  status: string;
  cropBox?: { x: number; y: number; width: number; height: number } | null;
  onClose: () => void;
};

export const FloatingTextPopup: React.FC<Props> = ({ text, isLoading, progress, status, cropBox, onClose }) => {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const [translatedText, setTranslatedText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });
  const translateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (textRef.current && !isLoading) {
      if (text) {
        textRef.current.textContent = text;
        setTranslatedText('⏳ Translating...');
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
          .then((settings: Settings) => {
            const tgtLang = settings?.translation?.defaultTargetLanguage || 'en';
            return translate(text, tgtLang);
          })
          .then(res => setTranslatedText(res.text))
          .catch(err => {
            console.error('Translation error:', err);
            setTranslatedText('⚠ Translation failed');
          });
      } else {
        textRef.current.innerHTML = '<span style="color:#888" contenteditable="false">No text recognized.</span>';
        setTranslatedText('');
      }
    }
  }, [text, isLoading]);

  const handleInput = () => {
    if (translateTimerRef.current) {
      clearTimeout(translateTimerRef.current);
    }
    translateTimerRef.current = setTimeout(() => {
      const currentText = textRef.current?.innerText || textRef.current?.textContent || '';
      if (!currentText.trim()) {
        setTranslatedText('');
        return;
      }
      setTranslatedText('⏳ Translating...');
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
        .then((settings: Settings) => {
          const tgtLang = settings?.translation?.defaultTargetLanguage || 'en';
          return translate(currentText, tgtLang);
        })
        .then(res => setTranslatedText(res.text))
        .catch(err => {
          console.error('Translation error:', err);
          setTranslatedText('⚠ Translation failed');
        });
    }, 1000);
  };

  const handleReadAloud = async () => {
    if (isPlaying) {
      window.speechSynthesis.cancel();
      setIsPlaying(false);
      return;
    }

    const currentText = textRef.current?.innerText || textRef.current?.textContent || text;
    if (!currentText) return;

    try {
      const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const utterance = new SpeechSynthesisUtterance(currentText);
      if (settings?.readAloud) {
        utterance.rate = settings.readAloud.speed || 1;
        utterance.pitch = settings.readAloud.pitch || 1;
        utterance.volume = settings.readAloud.volume || 1;
        if (settings.readAloud.voice) {
          const voices = window.speechSynthesis.getVoices();
          const voice = voices.find(v => v.name === settings.readAloud.voice);
          if (voice) utterance.voice = voice;
        }
      }
      utterance.onend = () => setIsPlaying(false);
      utterance.onerror = () => setIsPlaying(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      setIsPlaying(true);
    } catch (err) {
      console.error('Failed to read aloud', err);
    }
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Element;
      // Ignore if clicking inside the popup
      if (popupRef.current && popupRef.current.contains(target)) return;
      // Ignore if clicking inside dictionary popover or tooltip
      if (target.closest('.cxt-dict-host') || target.closest('.cxt-delete-tooltip')) return;

      onClose();
    };

    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
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
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      ref={popupRef}
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
        <span style={{ fontSize: 13, fontWeight: 'bold', color: '#aab' }}>OCR Result</span>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button
            onClick={handleReadAloud}
            title="Read Aloud"
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
            onClick={onClose}
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
            {translatedText && (
              <div style={{
                fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif",
                fontSize: '0.875em',
                color: translatedText.startsWith('⚠') ? '#ff6b6b' : translatedText.startsWith('⏳') ? '#8888aa' : '#6bcfff',
                padding: '3px 0 5px 10px',
                borderLeft: `2px solid ${translatedText.startsWith('⚠') ? '#aa3333' : translatedText.startsWith('⏳') ? '#3a3a5a' : '#2a3a5a'}`,
                fontStyle: translatedText.startsWith('⏳') ? 'italic' : 'normal',
                lineHeight: 1.6
              }}>
                {translatedText}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
