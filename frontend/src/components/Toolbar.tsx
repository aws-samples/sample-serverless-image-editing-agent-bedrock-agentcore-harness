import { Upload, Undo2, Trash2, RefreshCw } from 'lucide-react';
import { useRef } from 'react';

interface ToolbarProps {
  brushSize: number;
  onBrushSizeChange: (size: number) => void;
  onUpload: (file: File) => void;
  onUndo: () => void;
  onClear: () => void;
  onNewSession: () => void;
  hasStrokes: boolean;
  isUploading: boolean;
}

export function Toolbar({
  brushSize,
  onBrushSizeChange,
  onUpload,
  onUndo,
  onClear,
  onNewSession,
  hasStrokes,
  isUploading,
}: ToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUpload(file);
      e.target.value = '';
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] shrink-0 bg-white/[0.02]">
      {/* Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="btn-primary flex items-center gap-1.5 !px-3 !py-1.5 text-xs"
      >
        <Upload className="w-3.5 h-3.5" />
        {isUploading ? 'Uploading...' : 'Upload'}
      </button>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.08]" />

      {/* Brush Size */}
      <div className="flex items-center gap-2.5">
        <label className="text-[11px] text-gray-400 whitespace-nowrap font-medium">
          Brush: <span className="text-amber-400">{brushSize}px</span>
        </label>
        <input
          type="range"
          min={5}
          max={100}
          value={brushSize}
          onChange={(e) => onBrushSizeChange(Number(e.target.value))}
          className="w-24"
        />
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.08]" />

      {/* Undo */}
      <button
        onClick={onUndo}
        disabled={!hasStrokes}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 rounded-lg transition-all duration-200"
        title="Undo last stroke"
      >
        <Undo2 className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Undo</span>
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        disabled={!hasStrokes}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 rounded-lg transition-all duration-200"
        title="Clear all strokes"
      >
        <Trash2 className="w-3.5 h-3.5" />
        <span className="hidden md:inline">Clear</span>
      </button>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.08]" />

      {/* New Session */}
      <button
        onClick={onNewSession}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-all duration-200"
        title="Start new session"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        <span className="hidden md:inline">New</span>
      </button>
    </div>
  );
}
