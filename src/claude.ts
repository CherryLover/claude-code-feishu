import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';
import { ClaudeEvent } from './types';

// 详细日志文件路径
const LOG_DIR = path.resolve(process.cwd(), 'log');
const DETAIL_LOG_PATH = path.join(LOG_DIR, 'claude-detail.log');

// 确保 log 目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logDetail(eventType: string, data: unknown): void {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const line = `[${timestamp}] [${eventType}] ${json}\n`;
  fs.appendFile(DETAIL_LOG_PATH, line, (err) => {
    if (err) console.error('[Claude] 写入详情日志失败:', err.message);
  });
}

// MCP 服务器类型
type McpServer = ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer>;

// 生成 streaming input 消息（MCP 工具需要此格式）
async function* generateMessages(prompt: string): AsyncGenerator<any> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
  };
}

export interface StreamClaudeOptions {
  mcpServers?: Record<string, McpServer>;
  abortSignal?: AbortSignal;
}

export async function* streamClaudeChat(
  prompt: string,
  sessionId: string | null,
  options?: StreamClaudeOptions
): AsyncGenerator<ClaudeEvent> {
  const queryOptions: Record<string, unknown> = {
    cwd: config.workspace,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    settingSources: ['project', 'user'],
  };

  if (sessionId) {
    queryOptions.resume = sessionId;
  }

  // 注入 MCP 工具
  if (options?.mcpServers) {
    queryOptions.mcpServers = options.mcpServers;
  }

  let currentTool: string | null = null;
  let toolInput = '';
  let newSessionId: string | null = null;

  try {
    // 使用 MCP 工具时需要 streaming input 模式
    const promptInput = options?.mcpServers ? generateMessages(prompt) : prompt;

    for await (const message of query({ prompt: promptInput, options: queryOptions })) {
      // 检查中断信号
      if (options?.abortSignal?.aborted) {
        logDetail('aborted', { reason: 'AbortSignal triggered' });
        return;
      }

      // 记录原始消息
      logDetail(message.type, message);

      // 系统初始化消息 - 获取 session_id
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logDetail('session_init', { sessionId: message.session_id });
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
        // 提取 usage 信息
        let usage: ClaudeEvent['usage'] | undefined;
        if (msg.modelUsage) {
          const models = Object.keys(msg.modelUsage);
          if (models.length > 0) {
            let totalInput = 0;
            let totalOutput = 0;
            let contextWindow = 0;
            let totalCost = 0;
            for (const model of models) {
              const m = msg.modelUsage[model];
              totalInput += m.inputTokens || 0;
              totalOutput += m.outputTokens || 0;
              totalCost += m.costUSD || 0;
              if (m.contextWindow > contextWindow) contextWindow = m.contextWindow;
            }
            usage = { inputTokens: totalInput, outputTokens: totalOutput, contextWindow, costUSD: msg.total_cost_usd ?? totalCost };
          }
        }
        yield {
          type: 'result',
          content: msg.subtype === 'success' ? msg.result : (msg.error || '执行出错'),
          sessionId: newSessionId || sessionId || undefined,
          usage,
        };
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    logDetail('error', { message: errMsg, stack: error instanceof Error ? error.stack : undefined });
    yield { type: 'error', content: errMsg };
  }
}
