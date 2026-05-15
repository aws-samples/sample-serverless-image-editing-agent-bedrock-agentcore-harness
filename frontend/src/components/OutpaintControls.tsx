import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown } from 'lucide-react';

interface OutpaintControlsProps {
  directions: string[];
  onDirectionsChange: (dirs: string[]) => void;
  extendPixels: number;
  onExtendPixelsChange: (px: number) => void;
}

const DIRECTION_OPTIONS = [
  { id: 'left', label: 'L', icon: ArrowLeft },
  { id: 'right', label: 'R', icon: ArrowRight },
  { id: 'up', label: 'U', icon: ArrowUp },
  { id: 'down', label: 'D', icon: ArrowDown },
] as const;

export function OutpaintControls({
  directions,
  onDirectionsChange,
  extendPixels,
  onExtendPixelsChange,
}: OutpaintControlsProps) {
  const MAX_DIRECTIONS = 2;

  const toggleDirection = (dir: string) => {
    if (directions.includes(dir)) {
      // Don't allow deselecting the last direction
      if (directions.length === 1) return;
      onDirectionsChange(directions.filter((d) => d !== dir));
    } else {
      // Don't allow more than 2 directions
      if (directions.length >= MAX_DIRECTIONS) return;
      onDirectionsChange([...directions, dir]);
    }
  };

  return (
    <div className="flex items-center gap-2.5">
      {/* Direction toggles */}
      <div className="flex items-center gap-1">
        {DIRECTION_OPTIONS.map(({ id, icon: Icon }) => {
          const isActive = directions.includes(id);
          const isDisabled = !isActive && directions.length >= MAX_DIRECTIONS;
          return (
            <button
              key={id}
              onClick={() => toggleDirection(id)}
              disabled={isDisabled}
              className={`w-7 h-7 flex items-center justify-center rounded-md transition-all duration-200 ${
                isActive
                  ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30'
                  : isDisabled
                  ? 'text-gray-600 border border-transparent opacity-40 cursor-not-allowed'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] border border-transparent'
              }`}
              title={isDisabled ? 'Max 2 directions' : `Extend ${id}`}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.08]" />

      {/* Extension pixels slider */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-gray-400 whitespace-nowrap font-medium">
          Extend: <span className="text-amber-400">{extendPixels}px</span>
        </label>
        <input
          type="range"
          min={256}
          max={1024}
          step={64}
          value={extendPixels}
          onChange={(e) => onExtendPixelsChange(Number(e.target.value))}
          className="w-20"
        />
      </div>
    </div>
  );
}
