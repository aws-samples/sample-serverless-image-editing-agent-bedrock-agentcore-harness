import { Download } from 'lucide-react';

interface ImageResultProps {
  imageUrl: string;
  imageKey: string;
  onDownload: (key: string) => void;
}

export function ImageResult({ imageUrl, imageKey, onDownload }: ImageResultProps) {
  return (
    <div className="relative group rounded-xl overflow-hidden border border-white/[0.08]">
      <img
        src={imageUrl}
        alt="Generated result"
        className="w-full rounded-xl"
        loading="lazy"
      />
      {/* Download overlay on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-200 flex items-center justify-center backdrop-blur-0 group-hover:backdrop-blur-[2px]">
        <button
          onClick={() => onDownload(imageKey)}
          className="opacity-0 group-hover:opacity-100 transition-all duration-200 scale-90 group-hover:scale-100 flex items-center gap-1.5 px-3 py-1.5 bg-white/90 hover:bg-white text-gray-900 text-xs font-medium rounded-lg shadow-lg"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </button>
      </div>
    </div>
  );
}
