import { useState, useCallback, useEffect } from 'react';
import { ImageCanvas } from '../components/ImageCanvas';
import { Toolbar } from '../components/Toolbar';
import { ChatThread } from '../components/ChatThread';
import { PromptInput } from '../components/PromptInput';
import { SettingsPanel } from '../components/SettingsPanel';
import { BehindTheScenes } from '../components/BehindTheScenes';
import { useMask } from '../hooks/useMask';
import { useAgent } from '../hooks/useAgent';
import { useStorage } from '../hooks/useStorage';

const MODEL_IDS: Record<string, string> = {
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

const EDIT_KEYWORDS = [
  'replace', 'change', 'make', 'turn', 'add', 'remove', 'extend',
  'expand', 'fill', 'put', 'swap', 'fix', 'enhance', 'brighten',
  'darken', 'color', 'paint', 'draw', 'erase', 'crop', 'resize',
  'outpaint', 'inpaint', 'edit', 'modify', 'transform', 'generate',
];

function resolveModelId(selected: string, prompt: string, hasMask: boolean): string | null {
  if (selected !== 'auto') {
    return MODEL_IDS[selected] || null;
  }

  // Auto mode: determine if this is an edit request or simple chat
  const lowerPrompt = prompt.toLowerCase();
  const isEditRequest = hasMask || EDIT_KEYWORDS.some((kw) => lowerPrompt.includes(kw));

  if (isEditRequest) {
    return null; // Use harness default (Sonnet) for edits
  }
  return 'us.anthropic.claude-haiku-4-5-20251001-v1:0'; // Cheap for simple chat
}

export function EditorPage() {
  const { strokes, brushSize, setBrushSize, addStroke, undo, clear, exportMask } = useMask();
  const { messages, isProcessing, sendMessage, startNewSession, resumeSession, hasPreviousSession, lastResultImageKey, lastMetadata } = useAgent();
  const { uploadImage, uploadMask, getPreSignedUrl, downloadImage } = useStorage();

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedModel, setSelectedModel] = useState('auto');
  const [selectedPersona, setSelectedPersona] = useState('general');

  // Restore canvas image when resuming a session
  useEffect(() => {
    if (lastResultImageKey && !imageKey) {
      setImageKey(lastResultImageKey);
      getPreSignedUrl(lastResultImageKey).then((url) => {
        setImageUrl(url);
        const img = new window.Image();
        img.onload = () => {
          setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.src = url;
      }).catch((err) => {
        console.error('Failed to restore canvas image on resume:', err);
      });
    }
  }, [lastResultImageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = useCallback(
    async (file: File) => {
      setIsUploading(true);
      try {
        const key = await uploadImage(file);
        setImageKey(key);
        clear();

        const url = await getPreSignedUrl(key);
        setImageUrl(url);

        const img = new window.Image();
        img.onload = () => {
          setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.src = url;
      } catch (err) {
        console.error('Upload failed:', err);
        alert(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setIsUploading(false);
      }
    },
    [uploadImage, getPreSignedUrl, clear]
  );

  const handleSendPrompt = useCallback(
    async (prompt: string) => {
      let maskKey: string | undefined;

      // Always export and upload the mask if there are strokes
      if (strokes.length > 0 && imageDimensions) {
        try {
          const maskBlob = await exportMask(imageDimensions.width, imageDimensions.height);
          maskKey = await uploadMask(maskBlob);
        } catch (err) {
          console.error('Mask export failed:', err);
        }
      }

      // Resolve model ID based on selection and message context
      const hasMask = !!maskKey;
      const resolvedModelId = resolveModelId(selectedModel, prompt, hasMask);

      // Send the raw user prompt - the agent decides which tool to use
      const result = await sendMessage(
        prompt,
        imageKey || undefined,
        maskKey,
        resolvedModelId,
        selectedPersona !== 'general' ? selectedPersona : undefined
      );

      // Clear mask strokes after sending (edit result shows in chat, canvas keeps original)
      if (result?.resultImageKey) {
        clear();
      }
    },
    [strokes, imageDimensions, exportMask, uploadMask, sendMessage, imageKey, getPreSignedUrl, clear, selectedModel, selectedPersona]
  );

  const handleNewSession = useCallback(() => {
    startNewSession();
    setImageUrl(null);
    setImageKey(null);
    setImageDimensions(null);
    clear();
  }, [startNewSession, clear]);

  const handleGetImageUrl = useCallback(
    async (key: string): Promise<string> => {
      return getPreSignedUrl(key);
    },
    [getPreSignedUrl]
  );

  const handleDownloadImage = useCallback(
    (key: string) => {
      downloadImage(key).catch((err) => {
        console.error('Download failed:', err);
      });
    },
    [downloadImage]
  );

  return (
    <div className="flex-1 grid grid-cols-[1.5fr_1fr] gap-3 p-3 min-h-0">
      {/* Left Panel: Canvas + Toolbar */}
      <div className="flex flex-col min-h-0 rounded-2xl overflow-hidden glass">
        <Toolbar
          brushSize={brushSize}
          onBrushSizeChange={setBrushSize}
          onUpload={handleUpload}
          onUndo={undo}
          onClear={clear}
          onNewSession={handleNewSession}
          hasStrokes={strokes.length > 0}
          isUploading={isUploading}
        />
        <ImageCanvas
          imageUrl={imageUrl}
          strokes={strokes}
          brushSize={brushSize}
          onStrokeComplete={addStroke}
          onUpload={handleUpload}
        />
      </div>

      {/* Right Panel: Chat + Prompt */}
      <div className="flex flex-col min-h-0 rounded-2xl overflow-hidden glass">
        <div className="px-4 py-3 border-b border-white/[0.06] shrink-0">
          <h2 className="text-sm font-semibold text-gray-200 tracking-tight">Chat</h2>
          <div className="flex gap-3 mt-1.5">
            <p className="text-[10px] text-gray-500 leading-relaxed">
              <span className="text-amber-400/80 font-medium">Replace:</span> Describe what to change - no mask needed
            </p>
            <p className="text-[10px] text-gray-500 leading-relaxed">
              <span className="text-amber-400/80 font-medium">Inpaint:</span> Draw a mask, then describe what to put there
            </p>
            <p className="text-[10px] text-gray-500 leading-relaxed">
              <span className="text-amber-400/80 font-medium">Outpaint:</span> Say "extend left/right/up/down" to expand
            </p>
          </div>
        </div>
        <SettingsPanel
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          selectedPersona={selectedPersona}
          onPersonaChange={setSelectedPersona}
        />
        {hasPreviousSession && messages.length === 0 && (
          <div className="px-4 py-3 border-b border-white/[0.06] bg-amber-600/5">
            <p className="text-xs text-gray-300 mb-2">You have a previous editing session.</p>
            <div className="flex gap-2">
              <button
                onClick={resumeSession}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600/20 text-amber-300 border border-amber-500/30 hover:bg-amber-600/30 transition-colors"
              >
                Continue
              </button>
              <button
                onClick={handleNewSession}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:bg-white/[0.08] transition-colors"
              >
                Start Fresh
              </button>
            </div>
          </div>
        )}
        <ChatThread
          messages={messages}
          isProcessing={isProcessing}
          onGetImageUrl={handleGetImageUrl}
          onDownloadImage={handleDownloadImage}
        />
        <PromptInput
          onSend={handleSendPrompt}
          disabled={isProcessing}
          placeholder={
            !imageKey
              ? 'Upload an image first, then describe your edit...'
              : 'Describe what you want to do with this image...'
          }
        />
        <BehindTheScenes metadata={lastMetadata} />
      </div>
    </div>
  );
}
