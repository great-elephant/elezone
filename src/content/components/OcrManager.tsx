import React, { useState, useEffect } from 'react';
import { CropOverlay } from './CropOverlay';
import { FloatingTextPopup } from './FloatingTextPopup';
import { recognizeText } from '../modules/ocr';
import { Settings } from '../../shared/types';

type State = 'idle' | 'cropping' | 'processing' | 'done';

export const OcrManager: React.FC = () => {
  const [state, setState] = useState<State>('idle');
  const [screenshot, setScreenshot] = useState<string>('');
  const [ocrText, setOcrText] = useState('');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const handleMessage = (msg: any) => {
      if (msg.type === 'START_CROP_MODE') {
        // Request a screenshot from the background script
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
      }
    };
    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  const handleCropComplete = async (croppedDataUrl: string) => {
    setState('processing');
    setProgress(0);
    setStatus('Initializing OCR...');
    
    try {
      let text = await recognizeText(croppedDataUrl, (statusStr, prog) => {
        setStatus(statusStr);
        setProgress(prog);
      });

      try {
        const settings: Settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        const ocr = settings?.ocr;
        if (ocr) {
          if (ocr.removeExtraSpaces) {
            text = text.replace(/\s+/g, ' ').trim();
          }
          if (ocr.sentenceCase) {
            text = text.toLowerCase()
              .replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, prefix, char) => prefix + char.toUpperCase())
              .replace(/\b(i)(['’](m|ll|d|ve))?\b/g, (_, _i, suffix) => 'I' + (suffix || ''));
          }
        }
      } catch (e) {
        console.error('Failed to get settings for OCR formatting', e);
      }

      setOcrText(text);
      setState('done');
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
          onClose={handleClosePopup}
        />
      )}
    </>
  );
};
