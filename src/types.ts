export interface ClaudeEvent {
  type: 'tool_start' | 'tool_end' | 'tool_result' | 'text' | 'result' | 'error';
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  content?: string;
  sessionId?: string;
  usage?: UsageInfo;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  contextWindow?: number;
  costUSD?: number;
}

export interface StreamChatOptions {
  abortSignal?: AbortSignal;
  feishuClient?: any;
  chatId?: string;
}

export interface Session {
  claudeSessionId: string | null;
  lastActivity: number;
}
