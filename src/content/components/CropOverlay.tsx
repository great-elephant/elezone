import React, { useState, useEffect } from 'react';

type Point = { x: number; y: number };

type Rect = { x: number; y: number; width: number; height: number };

type Props = {
  screenshotDataUrl: string;
  onCropComplete: (croppedDataUrl: string, rect: Rect) => void;
  onCancel: () => void;
};

export const CropOverlay: React.FC<Props> = ({ screenshotDataUrl, onCropComplete, onCancel }) => {
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setStartPoint({ x: e.clientX, y: e.clientY });
    setCurrentPoint({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setCurrentPoint({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    if (!isDragging || !startPoint || !currentPoint) return;
    setIsDragging(false);

    const x = Math.min(startPoint.x, currentPoint.x);
    const y = Math.min(startPoint.y, currentPoint.y);
    const width = Math.abs(currentPoint.x - startPoint.x);
    const height = Math.abs(currentPoint.y - startPoint.y);

    if (width < 10 || height < 10) {
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    // Crop the image
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      // scale coordinates to match actual device pixels
      const ratio = window.devicePixelRatio || 1;
      ctx.drawImage(
        img,
        x * ratio, y * ratio, width * ratio, height * ratio,
        0, 0, width, height
      );
      onCropComplete(canvas.toDataURL('image/png'), { x, y, width, height });
    };
    img.src = screenshotDataUrl;
  };

  const selectionStyle: React.CSSProperties = {
    position: 'absolute',
    border: '2px dashed #fff',
    outline: '2px dashed #000',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    pointerEvents: 'none',
    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
  };

  if (startPoint && currentPoint) {
    selectionStyle.left = Math.min(startPoint.x, currentPoint.x);
    selectionStyle.top = Math.min(startPoint.y, currentPoint.y);
    selectionStyle.width = Math.abs(currentPoint.x - startPoint.x);
    selectionStyle.height = Math.abs(currentPoint.y - startPoint.y);
  } else {
    // When not selecting, dim the whole screen
    selectionStyle.left = 0;
    selectionStyle.top = 0;
    selectionStyle.width = 0;
    selectionStyle.height = 0;
    selectionStyle.boxShadow = '0 0 0 9999px rgba(0, 0, 0, 0.5)';
  }

  // A high-contrast crosshair cursor that is properly URL encoded and thicker
  const crosshairCursor = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Cpath stroke='%23000000' stroke-width='6' stroke-linecap='round' d='M24 8v32M8 24h32'/%3E%3Cpath stroke='%23ffffff' stroke-width='2' stroke-linecap='round' d='M24 8v32M8 24h32'/%3E%3C/svg%3E") 24 24, crosshair`;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        cursor: crosshairCursor,
        overflow: 'hidden'
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div style={selectionStyle} />
      {!startPoint && (
        <div style={{
          position: 'absolute',
          top: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(0,0,0,0.7)',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: 4,
          fontFamily: 'sans-serif',
          pointerEvents: 'none',
          zIndex: 2147483647
        }}>
          Drag to select text area, or press Esc to cancel
        </div>
      )}
    </div>
  );
};
