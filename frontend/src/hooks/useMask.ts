import { useState, useCallback } from 'react';
import type { BrushStroke } from '../types';

const MIN_BRUSH_SIZE = 5;
const MAX_BRUSH_SIZE = 100;
const DEFAULT_BRUSH_SIZE = 20;

interface UseMaskReturn {
  strokes: BrushStroke[];
  brushSize: number;
  setBrushSize: (size: number) => void;
  addStroke: (stroke: BrushStroke) => void;
  undo: () => void;
  clear: () => void;
  exportMask: (width: number, height: number) => Promise<Blob>;
}

export function useMask(): UseMaskReturn {
  const [strokes, setStrokes] = useState<BrushStroke[]>([]);
  const [brushSize, setBrushSizeState] = useState<number>(DEFAULT_BRUSH_SIZE);

  const setBrushSize = useCallback((size: number) => {
    const clamped = Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, size));
    setBrushSizeState(clamped);
  }, []);

  const addStroke = useCallback((stroke: BrushStroke) => {
    setStrokes((prev) => [...prev, stroke]);
  }, []);

  const undo = useCallback(() => {
    setStrokes((prev) => prev.slice(0, -1));
  }, []);

  const clear = useCallback(() => {
    setStrokes([]);
  }, []);

  const exportMask = useCallback(
    async (width: number, height: number): Promise<Blob> => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;

      // Fill with black (preserve)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      // Draw strokes in white (edit regions)
      ctx.strokeStyle = '#ffffff';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const stroke of strokes) {
        if (stroke.points.length === 0) continue;
        ctx.lineWidth = stroke.brushSize;
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }

      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to export mask as PNG'));
            }
          },
          'image/png'
        );
      });
    },
    [strokes]
  );

  return {
    strokes,
    brushSize,
    setBrushSize,
    addStroke,
    undo,
    clear,
    exportMask,
  };
}
