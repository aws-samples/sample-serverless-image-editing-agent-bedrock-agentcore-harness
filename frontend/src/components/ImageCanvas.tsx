import { useRef, useState, useEffect, useCallback } from 'react';
import { Stage, Layer, Image as KonvaImage, Line, Circle } from 'react-konva';
import { Upload } from 'lucide-react';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { BrushStroke } from '../types';

interface ImageCanvasProps {
  imageUrl: string | null;
  strokes: BrushStroke[];
  brushSize: number;
  onStrokeComplete: (stroke: BrushStroke) => void;
  onUpload?: (file: File) => void;
}

export function ImageCanvas({
  imageUrl,
  strokes,
  brushSize,
  onStrokeComplete,
  onUpload,
}: ImageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageScale, setImageScale] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Resize observer for responsive canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Load image when URL changes
  useEffect(() => {
    if (!imageUrl) {
      setImage(null);
      return;
    }

    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setImage(img);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Calculate image fit when image or dimensions change
  useEffect(() => {
    if (!image) {
      setImageScale(1);
      setImageOffset({ x: 0, y: 0 });
      return;
    }

    const { width: cw, height: ch } = dimensions;
    const iw = image.naturalWidth;
    const ih = image.naturalHeight;

    const scale = Math.min(cw / iw, ch / ih, 1);
    const offsetX = (cw - iw * scale) / 2;
    const offsetY = (ch - ih * scale) / 2;

    setImageScale(scale);
    setImageOffset({ x: offsetX, y: offsetY });
  }, [image, dimensions]);

  // Convert stage coordinates to image coordinates
  const stageToImage = useCallback(
    (stageX: number, stageY: number) => {
      return {
        x: (stageX - imageOffset.x) / imageScale,
        y: (stageY - imageOffset.y) / imageScale,
      };
    },
    [imageOffset, imageScale]
  );

  const handleMouseDown = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (!image) return;
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    const imgPos = stageToImage(pos.x, pos.y);
    setIsDrawing(true);
    setCurrentStroke([imgPos]);
  };

  const handleMouseMove = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = e.target.getStage();
    const pos = stage?.getPointerPosition();
    if (!pos) return;

    setCursorPos(pos);

    if (!isDrawing) return;

    const imgPos = stageToImage(pos.x, pos.y);
    setCurrentStroke((prev) => [...prev, imgPos]);
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    if (currentStroke.length > 0) {
      onStrokeComplete({
        points: currentStroke,
        brushSize,
      });
    }
    setCurrentStroke([]);
  };

  const handleMouseLeave = () => {
    setCursorPos(null);
    if (isDrawing) {
      handleMouseUp();
    }
  };

  // Convert stroke points to flat array for Konva Line
  const strokeToFlatPoints = (points: { x: number; y: number }[]): number[] => {
    const flat: number[] = [];
    for (const p of points) {
      flat.push(p.x * imageScale + imageOffset.x);
      flat.push(p.y * imageScale + imageOffset.y);
    }
    return flat;
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 relative overflow-hidden bg-gray-950/50"
      style={{ cursor: image ? 'none' : 'default' }}
    >
      <Stage
        width={dimensions.width}
        height={dimensions.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleMouseDown}
        onTouchMove={handleMouseMove}
        onTouchEnd={handleMouseUp}
      >
        {/* Image Layer */}
        <Layer>
          {image && (
            <KonvaImage
              image={image}
              x={imageOffset.x}
              y={imageOffset.y}
              width={image.naturalWidth * imageScale}
              height={image.naturalHeight * imageScale}
            />
          )}
        </Layer>

        {/* Mask Strokes Layer */}
        <Layer>
          {strokes.map((stroke, i) => (
            <Line
              key={i}
              points={strokeToFlatPoints(stroke.points)}
              stroke="rgba(239, 68, 68, 0.5)"
              strokeWidth={stroke.brushSize * imageScale}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation="source-over"
            />
          ))}
          {/* Current stroke being drawn */}
          {currentStroke.length > 0 && (
            <Line
              points={strokeToFlatPoints(currentStroke)}
              stroke="rgba(239, 68, 68, 0.5)"
              strokeWidth={brushSize * imageScale}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation="source-over"
            />
          )}
        </Layer>

        {/* Cursor Layer */}
        <Layer>
          {cursorPos && image && (
            <Circle
              x={cursorPos.x}
              y={cursorPos.y}
              radius={(brushSize * imageScale) / 2}
              stroke="white"
              strokeWidth={1.5}
              dash={[4, 4]}
              listening={false}
            />
          )}
        </Layer>
      </Stage>

      {/* Empty state with upload button */}
      {!image && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <span className="text-3xl">🖼️</span>
            </div>
            <p className="text-sm font-medium text-gray-300 mb-1">Upload an image to get started</p>
            <p className="text-xs text-gray-500 mb-4">
              Supports JPEG and PNG up to 10 MB
            </p>
            {onUpload && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      onUpload(file);
                      e.target.value = '';
                    }
                  }}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-primary flex items-center gap-2 mx-auto px-4 py-2 text-sm"
                >
                  <Upload className="w-4 h-4" />
                  Upload Image
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
