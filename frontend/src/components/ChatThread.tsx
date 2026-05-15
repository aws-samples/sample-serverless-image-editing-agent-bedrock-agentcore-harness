import { useEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import { ImageResult } from './ImageResult';

interface ChatThreadProps {
  messages: Message[];
  isProcessing: boolean;
  onGetImageUrl: (key: string) => Promise<string>;
  onDownloadImage: (key: string) => void;
}

export function ChatThread({
  messages,
  isProcessing,
  onGetImageUrl,
  onDownloadImage,
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isProcessing]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto custom-scroll px-4 py-4 space-y-3"
    >
      {messages.length === 0 && !isProcessing && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center max-w-xs">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <span className="text-xl">💬</span>
            </div>
            <p className="text-sm font-medium text-gray-300">Start a conversation</p>
            <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
              Upload an image, paint a mask on the area you want to edit, then
              describe what you want to change.
            </p>
          </div>
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onGetImageUrl={onGetImageUrl}
          onDownloadImage={onDownloadImage}
        />
      ))}

      {isProcessing && (
        <div className="flex justify-start">
          <div className="bg-white/[0.04] border border-white/[0.06] rounded-2xl rounded-bl-md px-4 py-3 max-w-[85%]">
            <div className="flex items-center gap-2.5">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-gray-400">Processing...</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  onGetImageUrl: (key: string) => Promise<string>;
  onDownloadImage: (key: string) => void;
}

function MessageBubble({ message, onGetImageUrl, onDownloadImage }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (message.imageKey && message.role === 'assistant') {
      onGetImageUrl(message.imageKey).then(setImageUrl).catch(() => {});
    }
  }, [message.imageKey, message.role, onGetImageUrl]);

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] ${
          isUser
            ? 'bg-amber-600 rounded-2xl rounded-br-md'
            : 'bg-white/[0.04] border border-white/[0.06] rounded-2xl rounded-bl-md'
        } px-4 py-2.5`}
      >
        <p className="text-sm text-white whitespace-pre-wrap break-words leading-relaxed">
          {message.text}
        </p>

        {/* Inline result image for assistant messages */}
        {imageUrl && message.role === 'assistant' && message.imageKey && (
          <div className="mt-2.5">
            <ImageResult
              imageUrl={imageUrl}
              imageKey={message.imageKey}
              onDownload={onDownloadImage}
            />
          </div>
        )}

        <p
          className={`text-[10px] mt-1.5 ${
            isUser ? 'text-amber-200/70' : 'text-gray-500'
          }`}
        >
          {time}
        </p>
      </div>
    </div>
  );
}
