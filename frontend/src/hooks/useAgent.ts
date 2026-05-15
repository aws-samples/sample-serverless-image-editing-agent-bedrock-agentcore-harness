import { useState, useCallback, useRef, useEffect } from 'react';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { useAuth } from './useAuth';
import { config } from '../config';
import type { Message, AgentResponse } from '../types';

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const STORAGE_KEY = 'pixelforge-session';
const ACTOR_ID_KEY = 'pixelforge-actor-id';

interface PersistedSession {
  sessionId: string;
  messages: Message[];
  lastResultImageKey: string | null;
  lastImageKey: string | null;
  timestamp: number;
}

interface RequestMetadata {
  model: string;
  persona: string;
  toolUsed: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stopReason: string | null;
}

interface UseAgentReturn {
  messages: Message[];
  isProcessing: boolean;
  sessionId: string | null;
  hasPreviousSession: boolean;
  lastResultImageKey: string | null;
  lastMetadata: RequestMetadata | null;
  sendMessage: (
    prompt: string,
    sourceImageKey?: string,
    maskKey?: string,
    modelOverride?: string | null,
    personaOverride?: string
  ) => Promise<AgentResponse | null>;
  startNewSession: () => void;
  resumeSession: () => void;
}

function getActorId(): string {
  let actorId = localStorage.getItem(ACTOR_ID_KEY);
  if (!actorId) {
    actorId = 'user-' + crypto.randomUUID();
    localStorage.setItem(ACTOR_ID_KEY, actorId);
  }
  return actorId;
}

function loadPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: PersistedSession = JSON.parse(raw);
    // Expire persisted sessions older than 24 hours
    if (Date.now() - parsed.timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function persistSession(session: PersistedSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage full or unavailable - silently ignore
  }
}

function clearPersistedSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function useAgent(): UseAgentReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hasPreviousSession, setHasPreviousSession] = useState(false);
  const [lastResultImageKey, setLastResultImageKey] = useState<string | null>(null);
  const [lastMetadata, setLastMetadata] = useState<RequestMetadata | null>(null);
  const lastActivityRef = useRef<number>(0);
  const lastResultImageKeyRef = useRef<string | null>(null);
  const { getCredentials } = useAuth();

  // Check for a persisted session on mount
  useEffect(() => {
    const persisted = loadPersistedSession();
    if (persisted && persisted.messages.length > 0) {
      setHasPreviousSession(true);
    }
  }, []);

  const getLambdaClient = useCallback(async (): Promise<LambdaClient> => {
    const credentials = await getCredentials();
    return new LambdaClient({
      region: config.region,
      credentials,
    });
  }, [getCredentials]);

  const isSessionExpired = useCallback((): boolean => {
    if (!sessionId || lastActivityRef.current === 0) {
      return false;
    }
    return Date.now() - lastActivityRef.current > SESSION_IDLE_TIMEOUT_MS;
  }, [sessionId]);

  const startNewSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    lastActivityRef.current = 0;
    lastResultImageKeyRef.current = null;
    setLastResultImageKey(null);
    setLastMetadata(null);
    clearPersistedSession();
    setHasPreviousSession(false);
  }, []);

  const resumeSession = useCallback(() => {
    const persisted = loadPersistedSession();
    if (persisted) {
      setSessionId(persisted.sessionId);
      setMessages(persisted.messages);
      lastResultImageKeyRef.current = persisted.lastResultImageKey;
      setLastResultImageKey(persisted.lastResultImageKey);
      lastActivityRef.current = Date.now(); // Reset to now so session doesn't immediately expire
      setHasPreviousSession(false);
    }
  }, []);

  const sendMessage = useCallback(
    async (
      prompt: string,
      sourceImageKey?: string,
      maskKey?: string,
      modelOverride?: string | null,
      personaOverride?: string
    ): Promise<AgentResponse | null> => {
      // Check for session expiry on follow-up messages
      if (sessionId && isSessionExpired()) {
        const expiredMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: 'Your session has expired due to inactivity. Please start a new session to continue.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, expiredMessage]);
        return null;
      }

      // Generate session ID on first message
      let currentSessionId = sessionId;
      if (!currentSessionId) {
        currentSessionId = crypto.randomUUID();
        setSessionId(currentSessionId);
      }

      // On follow-up messages, use most recent result image as source if none provided
      const effectiveSourceImageKey =
        sourceImageKey || lastResultImageKeyRef.current || undefined;

      // Add user message to conversation
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        text: prompt,
        imageKey: effectiveSourceImageKey,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        const lambdaClient = await getLambdaClient();

        // Build the payload for the invoke-harness Lambda
        const payload = {
          prompt,
          sessionId: currentSessionId,
          sourceImageKey: effectiveSourceImageKey,
          maskKey,
          actorId: getActorId(),
          modelOverride: modelOverride || undefined,
          personaOverride: personaOverride || undefined,
        };

        const command = new InvokeCommand({
          FunctionName: config.invokeHarnessFunctionName,
          Payload: new TextEncoder().encode(JSON.stringify(payload)),
        });

        const response = await lambdaClient.send(command);

        // Parse the Lambda response
        const responsePayload = response.Payload
          ? JSON.parse(new TextDecoder().decode(response.Payload))
          : null;

        if (!responsePayload || responsePayload.statusCode !== 200) {
          const errorBody = responsePayload?.body
            ? JSON.parse(responsePayload.body)
            : { message: 'Unknown error from harness' };
          throw new Error(errorBody.message || errorBody.error || 'Harness invocation failed');
        }

        const body = JSON.parse(responsePayload.body);
        const responseText = body.responseText || '';
        const returnedSessionId = body.sessionId || currentSessionId;

        // Capture metadata from the response
        if (body.metadata) {
          setLastMetadata(body.metadata as RequestMetadata);
        }

        // Update session ID if the harness returned one
        if (returnedSessionId !== currentSessionId) {
          setSessionId(returnedSessionId);
          currentSessionId = returnedSessionId;
        }

        // Parse structured data from the response
        const parsed = extractStructuredData(responseText);

        // Track the last result image key for follow-up messages
        if (parsed.resultImageKey) {
          lastResultImageKeyRef.current = parsed.resultImageKey;
          setLastResultImageKey(parsed.resultImageKey);
        }

        const agentResponse: AgentResponse = {
          sessionId: returnedSessionId,
          responseText: parsed.cleanText || responseText || 'No response received from the agent.',
          resultImageKey: parsed.resultImageKey,
          toolUsed: parsed.toolUsed,
        };

        // Add assistant message to conversation
        const assistantMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: agentResponse.responseText,
          imageKey: agentResponse.resultImageKey,
          timestamp: Date.now(),
        };

        setMessages((prev) => {
          const updated = [...prev, assistantMessage];
          // Persist session to localStorage
          persistSession({
            sessionId: currentSessionId!,
            messages: updated,
            lastResultImageKey: lastResultImageKeyRef.current,
            lastImageKey: lastResultImageKeyRef.current,
            timestamp: Date.now(),
          });
          return updated;
        });

        // Update last activity timestamp
        lastActivityRef.current = Date.now();
        // Clear the previous session flag since we are now active
        setHasPreviousSession(false);

        return agentResponse;
      } catch (error) {
        const errorMessage: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text:
            error instanceof Error
              ? `An error occurred: ${error.message}`
              : 'An unexpected error occurred. Please try again.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMessage]);
        return null;
      } finally {
        setIsProcessing(false);
      }
    },
    [sessionId, isSessionExpired, getLambdaClient]
  );

  return {
    messages,
    isProcessing,
    sessionId,
    hasPreviousSession,
    lastResultImageKey,
    lastMetadata,
    sendMessage,
    startNewSession,
    resumeSession,
  };
}

function extractStructuredData(text: string): {
  resultImageKey?: string;
  toolUsed?: 'inpaint' | 'outpaint' | null;
  cleanText?: string;
} {
  let resultImageKey: string | undefined;
  let toolUsed: 'inpaint' | 'outpaint' | null = null;

  // Look for result image key patterns in the response:
  // 1. JSON-style: result_image_key: "users/..." or result_image_key: 'users/...'
  const jsonKeyMatch = text.match(
    /result_image_key["\s:]*["']?(users\/[^"'\s]+)["']?/
  );
  if (jsonKeyMatch) {
    resultImageKey = jsonKeyMatch[1];
  }

  // 2. Backtick-wrapped S3 key: `users/.../results/uuid.png`
  if (!resultImageKey) {
    const backtickMatch = text.match(/`(users\/[^`\s]+\.png)`/);
    if (backtickMatch) {
      resultImageKey = backtickMatch[1];
    }
  }

  // 3. "Result Image Key:" prefix pattern (with or without backticks)
  if (!resultImageKey) {
    const prefixMatch = text.match(
      /[Rr]esult\s*[Ii]mage\s*[Kk]ey[:\s]+`?(users\/[^`\s"']+\.png)`?/
    );
    if (prefixMatch) {
      resultImageKey = prefixMatch[1];
    }
  }

  // Detect which tool was used
  if (text.includes('search_and_replace') || text.includes('search and replace')) {
    toolUsed = 'inpaint'; // Treat as inpaint category for UI purposes
  } else if (text.includes('inpaint')) {
    toolUsed = 'inpaint';
  } else if (text.includes('outpaint')) {
    toolUsed = 'outpaint';
  }

  return {
    resultImageKey,
    toolUsed,
    cleanText: text,
  };
}
