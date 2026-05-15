export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageKey?: string;
  timestamp: number;
}

export interface AgentResponse {
  sessionId: string;
  responseText: string;
  resultImageKey?: string;
  toolUsed?: 'inpaint' | 'outpaint' | null;
}

export interface BrushStroke {
  points: Array<{ x: number; y: number }>;
  brushSize: number;
}
