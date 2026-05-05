export type TaskStatus = 'pending' | 'running' | 'completed';

export interface Task {
  id: string;
  title: string;
  agentId: string;
  workingDirectory: string;
  status: TaskStatus;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageBlock {
  type: 'thinking' | 'tool' | 'text';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
}

export interface Message {
  id: string;
  taskId: string;
  role: 'user' | 'assistant';
  content: string;
  blocks: MessageBlock[];
  usage?: { input: number; output: number };
  duration?: number;
  createdAt: number;
}

export interface CreateTaskRequest {
  title: string;
  agentId: string;
  workingDirectory: string;
}

export interface SendMessageRequest {
  content: string;
}

// SSE 事件类型
export type StreamEvent =
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; content: string }
  | { type: 'thinking_end' }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; input: string }
  | { type: 'tool_end'; name: string; output: string }
  | { type: 'message_done'; messageId: string; usage?: { input: number; output: number }; duration?: number }
  | { type: 'error'; message: string };
