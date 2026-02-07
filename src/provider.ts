import { config } from './config';
import { ClaudeEvent, StreamChatOptions } from './types';

export async function* streamChat(
  prompt: string,
  sessionId: string | null,
  options?: StreamChatOptions,
): AsyncGenerator<ClaudeEvent> {
  if (config.aiProvider === 'codex') {
    const { streamCodexChat } = await import('./codex-provider');
    yield* streamCodexChat(prompt, sessionId, options);
  } else {
    const { streamClaudeChat } = await import('./claude');
    const { createFeishuToolsServer } = await import('./tools');

    let mcpServers: Record<string, any> | undefined;
    if (options?.feishuClient && options?.chatId) {
      const server = createFeishuToolsServer(options.feishuClient, options.chatId);
      mcpServers = { 'feishu-tools': server };
    }

    yield* streamClaudeChat(prompt, sessionId, {
      mcpServers,
      abortSignal: options?.abortSignal,
    });
  }
}

export function getProviderName(): string {
  return config.aiProvider === 'codex' ? 'Codex' : 'Claude Code';
}
