import { config } from './config.js';
import { ClaudeEvent, StreamChatOptions } from './types.js';

export async function* streamChat(
  prompt: string,
  sessionId: string | null,
  options?: StreamChatOptions,
): AsyncGenerator<ClaudeEvent> {
  if (config.aiProvider === 'codex') {
    const { streamCodexChat } = await import('./codex-provider.js');
    // 注入 chatId 上下文，让 Codex 知道 MCP 工具的 chat_id 参数该传什么
    let codexPrompt = prompt;
    if (options?.chatId) {
      codexPrompt = `[系统信息] 当前飞书聊天ID: ${options.chatId}\n当用户要求发送文件时，请使用 send_file_to_user 工具，chat_id 参数传入上述聊天ID。\n---\n${prompt}`;
    }
    yield* streamCodexChat(codexPrompt, sessionId, options);
  } else {
    const { streamClaudeChat } = await import('./claude.js');
    const { createFeishuToolsServer } = await import('./tools.js');

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
