import React, { useState, useEffect, useRef } from 'react';

type Props = {
  text: string;
  isLoading: boolean;
  progress: number;
  status: string;
  onClose: () => void;
};

export const FloatingTextPopup: React.FC<Props> = ({ text, isLoading, progress, status, onClose }) => {
  const [position, setPosition] = useState({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (textRef.current && !isLoading) {
      if (text) {
        textRef.current.textContent = text;
      } else {
        textRef.current.innerHTML = '<span style="color:#888" contenteditable="false">No text recognized.</span>';
      }
    }
  }, [text, isLoading]);

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
    // Initial centering
    setPosition({
      x: Math.max(20, window.innerWidth / 2 - 150),
      y: Math.max(20, window.innerHeight / 2 - 100)
    });
  }, []);

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

      <div style={{ padding: 16, fontSize: 16, lineHeight: 1.5, minHeight: 60, maxHeight: '60vh', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: '#88a' }}>
            <div style={{ fontSize: 13 }}>{status || 'Recognizing text...'}</div>
            <div style={{ width: '100%', height: 4, backgroundColor: '#2a2a4e', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(5, progress * 100)}%`, height: '100%', backgroundColor: '#6bcfff', transition: 'width 0.2s' }} />
            </div>
          </div>
        ) : (
          <div
            ref={textRef}
            contentEditable={true}
            suppressContentEditableWarning
            style={{ outline: 'none', cursor: 'text', minHeight: '60px', width: '100%' }}
          />
        )}
      </div>
    </div>
  );
};
