import { ChevronDown } from 'lucide-react';

interface SettingsPanelProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
  selectedPersona: string;
  onPersonaChange: (persona: string) => void;
}

const MODEL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'haiku', label: 'Claude Haiku' },
];

const PERSONA_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'retail', label: 'Retail' },
  { value: 'automotive', label: 'Automotive' },
];

export function SettingsPanel({
  selectedModel,
  onModelChange,
  selectedPersona,
  onPersonaChange,
}: SettingsPanelProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
      {/* Model Selector */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
          Model
        </label>
        <div className="relative">
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="appearance-none bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1 pr-6 text-xs text-gray-300 hover:border-amber-500/30 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/20 transition-colors cursor-pointer"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-gray-900 text-gray-200">
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
        </div>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-white/[0.08]" />

      {/* Persona Selector */}
      <div className="flex items-center gap-1.5">
        <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">
          Persona
        </label>
        <div className="relative">
          <select
            value={selectedPersona}
            onChange={(e) => onPersonaChange(e.target.value)}
            className="appearance-none bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1 pr-6 text-xs text-gray-300 hover:border-amber-500/30 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/20 transition-colors cursor-pointer"
          >
            {PERSONA_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-gray-900 text-gray-200">
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
        </div>
      </div>
    </div>
  );
}
