import { useState } from 'react';
import { Paintbrush, Expand, Info } from 'lucide-react';

export type EditMode = 'inpaint' | 'outpaint';

interface ModeSelectorProps {
  mode: EditMode;
  onModeChange: (mode: EditMode) => void;
}

const MODE_INFO = {
  inpaint: {
    label: 'Inpaint',
    icon: Paintbrush,
    description: 'Paint a mask over the area you want to change, then describe what should replace it. Great for removing objects, changing backgrounds, or replacing specific elements.',
  },
  outpaint: {
    label: 'Outpaint',
    icon: Expand,
    description: 'Extend your image beyond its original borders. Choose which direction(s) to expand and describe what should appear in the new area.',
  },
};

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  const [showTooltip, setShowTooltip] = useState<EditMode | null>(null);

  return (
    <div className="flex items-center gap-1 relative">
      {(Object.keys(MODE_INFO) as EditMode[]).map((m) => {
        const { label, icon: Icon } = MODE_INFO[m];
        const isActive = mode === m;

        return (
          <div key={m} className="relative">
            <button
              onClick={() => onModeChange(m)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-all duration-200 ${
                isActive
                  ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30'
                  : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>

            {/* Info icon */}
            <button
              onMouseEnter={() => setShowTooltip(m)}
              onMouseLeave={() => setShowTooltip(null)}
              onClick={() => setShowTooltip(showTooltip === m ? null : m)}
              className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full bg-gray-700 hover:bg-gray-600 transition-colors"
            >
              <Info className="w-2.5 h-2.5 text-gray-400" />
            </button>

            {/* Tooltip popup */}
            {showTooltip === m && (
              <div className="absolute top-full left-0 mt-2 z-50 w-64 p-3 bg-gray-800 border border-white/[0.08] rounded-xl shadow-xl">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-medium text-white">{label}</span>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  {MODE_INFO[m].description}
                </p>
                {/* Arrow */}
                <div className="absolute -top-1.5 left-4 w-3 h-3 bg-gray-800 border-l border-t border-white/[0.08] rotate-45" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
