import { config } from '../config.js';
import { ClaudeEvent, StreamChatOptions } from './types.js';

function buildPromptWithSystemContext(prompt: string, options?: StreamChatOptions): string {
  const lines: string[] = [];

  if (options?.chatId) {
    lines.push(`[系统信息] 当前飞书聊天ID: ${options.chatId}`);
    lines.push('当用户要求发送文件到当前会话时，请使用 send_file_to_user 工具，chat_id 参数传入上述聊天ID。');
    lines.push('当用户要求发送给指定用户时，可使用 send_file_to_user 的 open_id 参数。');
    lines.push('当用户要求创建或修改定时任务且未指定发送目标时，默认把结果发送到当前聊天。');
  }

  if (options?.workingDirectory) {
    lines.push(`[系统信息] 当前工作目录: ${options.workingDirectory}`);
    lines.push('当用户要求创建或修改定时任务且未指定 working_directory 时，默认使用上述工作目录。');
  }

  if (options?.senderOpenId || options?.senderName) {
    const senderIdentity = options.senderName
      ? `${options.senderName}${options.senderOpenId ? ` (${options.senderOpenId})` : ''}`
      : options.senderOpenId || 'unknown';

    lines.push(`[系统信息] 当前消息发送者: ${senderIdentity}`);
    lines.push('在用户原话中，“我/我们/找我/联系我/告诉我”等第一人称，默认指当前消息发送者，不是机器人。');
    lines.push('当代用户给第三方发消息、创建待办或创建日程时，不要保留含糊的“我”，要改写成明确对象。');
    lines.push('当用户要求“给我发日报/把结果发给我”且未指定目标时，优先发送到当前聊天；只有明确要求发私聊给某个用户时，才使用 open_id 作为目标。');
    lines.push('优先使用发送者姓名；若姓名未知，使用发送者 open_id。');
    lines.push('示例：把“让他明天来找我”改成“让他明天联系<发送者姓名>”。');
  }

  lines.push('当用户表达“每天/每周/定时/周期执行/定期提醒/日报巡检”等需求时，优先使用 schedule_* 工具创建或管理定时任务，而不是只给文字建议。');

  if (lines.length === 0) {
    return prompt;
  }

  return `${lines.join('\n')}\n---\n${prompt}`;
}

export async function* streamChat(
  prompt: string,
  sessionId: string | null,
  options?: StreamChatOptions,
): AsyncGenerator<ClaudeEvent> {
  const contextualPrompt = buildPromptWithSystemContext(prompt, options);

  if (config.aiProvider === 'codex') {
    const { streamCodexChat } = await import('./codex.js');
    yield* streamCodexChat(contextualPrompt, sessionId, options);
  } else {
    const { streamClaudeChat } = await import('./claude.js');
    const { createFeishuToolsServer } = await import('../tools/index.js');

    let mcpServers: Record<string, any> | undefined;
    if (options?.feishuClient && options?.chatId) {
      const server = createFeishuToolsServer(options.feishuClient, {
        chatId: options.chatId,
        workingDirectory: options.workingDirectory,
      });
      mcpServers = { 'feishu-tools': server };
    }

    yield* streamClaudeChat(contextualPrompt, sessionId, {
      mcpServers,
      abortSignal: options?.abortSignal,
      inputImages: options?.inputImages,
      workingDirectory: options?.workingDirectory,
    });
  }
}

export function getProviderName(): string {
  return config.aiProvider === 'codex' ? 'Codex' : 'Claude Code';
}
