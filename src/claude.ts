import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';
import { ClaudeEvent } from './types';

export async function* streamClaudeChat(
  prompt: string,
  sessionId: string | null
): AsyncGenerator<ClaudeEvent> {
  const options: Record<string, unknown> = {
    cwd: config.workspace,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    // 加载 CLAUDE.md 文件作为上下文
    // 'project' - 加载项目目录下的 CLAUDE.md
    // 'user' - 加载用户级别的 ~/.claude/CLAUDE.md
    settingSources: ['project', 'user'],
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  let currentTool: string | null = null;
  let toolInput = '';
  let newSessionId: string | null = null;

  try {
    for await (const message of query({ prompt, options })) {
      // 系统初始化消息 - 获取 session_id
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // 流式事件（需要 includePartialMessages: true）
      if (message.type === 'stream_event') {
        const event = (message as any).event;
        if (!event) continue;

        // 工具调用开始
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          currentTool = event.content_block.name;
          toolInput = '';
          yield { type: 'tool_start', toolName: currentTool! };
        }

        // 工具输入增量
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'input_json_delta') {
            toolInput += event.delta.partial_json || '';
          }
          if (event.delta?.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text };
          }
        }

        // 工具调用结束
        if (event.type === 'content_block_stop' && currentTool) {
          yield { type: 'tool_end', toolName: currentTool, toolInput };
          currentTool = null;
          toolInput = '';
        }
      }

      // 完整助手消息 - 解析工具执行结果
      if (message.type === 'assistant') {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const output = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              yield { type: 'tool_result', toolOutput: output };
            }
          }
        }
      }

      // 最终结果
      if (message.type === 'result') {
        const msg = message as any;
        yield {
          type: 'result',
          content: msg.subtype === 'success' ? msg.result : (msg.error || '执行出错'),
          sessionId: newSessionId || sessionId || undefined,
        };
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    yield { type: 'error', content: errMsg };
  }
}
