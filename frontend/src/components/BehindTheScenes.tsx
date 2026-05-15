import { Cpu, Wrench, Clock, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

export interface RequestMetadata {
  model: string;
  persona: string;
  toolUsed: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason: string | null;
}

interface BehindTheScenesProps {
  metadata: RequestMetadata | null;
}

const MODEL_LABELS: Record<string, string> = {
  'us.anthropic.claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'Claude Haiku',
};

const PERSONA_LABELS: Record<string, string> = {
  general: 'General',
  real_estate: 'Real Estate',
  retail: 'Retail',
  automotive: 'Automotive',
};

export function BehindTheScenes({ metadata }: BehindTheScenesProps) {
  const [expanded, setExpanded] = useState(true);

  if (!metadata) return null;

  const modelLabel = MODEL_LABELS[metadata.model] || metadata.model;
  const personaLabel = PERSONA_LABELS[metadata.persona] || metadata.persona;
  const latencySec = (metadata.latencyMs / 1000).toFixed(1);

  return (
    <div className="border-t border-white/[0.06] bg-white/[0.02]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="uppercase tracking-wider font-medium">Behind the Scenes</span>
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 grid grid-cols-2 gap-2">
          <div className="flex items-center gap-1.5">
            <Cpu className="w-3 h-3 text-amber-400/70" />
            <span className="text-[11px] text-gray-400">{modelLabel}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-amber-400/70" />
            <span className="text-[11px] text-gray-400">{latencySec}s</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Wrench className="w-3 h-3 text-amber-400/70" />
            <span className="text-[11px] text-gray-400">{metadata.toolUsed || 'None'}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-amber-400/70" />
            <span className="text-[11px] text-gray-400">{metadata.inputTokens} in / {metadata.outputTokens} out</span>
          </div>

          {metadata.persona !== 'general' && (
            <div className="col-span-2 flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500">Persona:</span>
              <span className="text-[11px] text-amber-400/70">{personaLabel}</span>
            </div>
          )}

          {(metadata as any).watermarked && (
            <div className="col-span-2 flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500">Post-process:</span>
              <span className="text-[11px] text-green-400/70">Watermark applied (shell cmd, 0 tokens)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
