import React, { useState, useEffect, useRef } from 'react';
import { CropOverlay } from './CropOverlay';
import { FloatingTextPopup } from './FloatingTextPopup';

import { Settings } from '../../shared/types';

type State = 'idle' | 'cropping' | 'processing' | 'done';

export const OcrManager: React.FC = () => {
  const [state, setState] = useState<State>('idle');
  const [screenshot, setScreenshot] = useState<string>('');
  const [ocrText, setOcrText] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [cropBox, setCropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const settingsRef = useRef<Settings | undefined>(undefined);

  useEffect(() => {
    const handleMessage = (msg: any) => {
      if (msg.type === 'START_CROP_MODE') {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' })
          .then((response: { dataUrl: string }) => {
            if (response?.dataUrl) {
              setScreenshot(response.dataUrl);
              setState('cropping');
            }
          })
          .catch(err => {
            console.error('Failed to capture tab:', err);
          });
      } else if (msg.type === 'OCR_PROGRESS') {
        setStatus(msg.payload.status);
        setProgress(msg.payload.progress ?? 0);
      } else if (msg.type === 'OCR_COMPLETE') {
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

  const handleCropComplete = async (croppedDataUrl: string, rect: { x: number; y: number; width: number; height: number }) => {
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

      // Fire-and-forget: background immediately acks, result comes back via OCR_COMPLETE message
      chrome.runtime.sendMessage({
        type: 'FORWARD_RECOGNIZE_TEXT',
        payload: { imageBase64: croppedDataUrl, lang }
      }).catch(() => {/* background ack can fail safely */});

    } catch (err) {
      console.error('OCR Error:', err);
      setOcrText('Error recognizing text.');
      setState('done');
    }
  };

  const handleCancelCrop = () => {
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
