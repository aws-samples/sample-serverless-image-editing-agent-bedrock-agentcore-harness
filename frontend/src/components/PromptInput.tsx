import { useState, useRef } from 'react';
import { SendHorizontal, Loader2 } from 'lucide-react';

interface PromptInputProps {
  onSend: (prompt: string) => void;
  disabled: boolean;
  placeholder?: string;
}

export function PromptInput({ onSend, disabled, placeholder }: PromptInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-resize textarea
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  return (
    <div className="px-4 py-3 border-t border-white/[0.06] shrink-0 bg-white/[0.02]">
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder || 'Describe what you want to edit...'}
          rows={1}
          className="flex-1 resize-none bg-white/[0.04] border border-white/[0.08] rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
          style={{ maxHeight: '120px' }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
            disabled || !text.trim()
              ? 'bg-white/[0.04]'
              : 'bg-amber-600 hover:bg-amber-700'
          }`}
          title="Send (Enter)"
        >
          {disabled ? (
            <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
          ) : (
            <SendHorizontal className="w-4 h-4 text-white" />
          )}
        </button>
      </div>
      <p className="text-[10px] text-gray-600 mt-1.5">
        Press Enter to send, Shift+Enter for new line
      </p>
    </div>
  );
}
