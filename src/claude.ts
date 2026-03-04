import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { ClaudeEvent, InputImage } from './types.js';

// 详细日志文件路径
const LOG_DIR = path.resolve(process.cwd(), 'log');
const DETAIL_LOG_PATH = path.join(LOG_DIR, 'claude-detail.log');

// 确保 log 目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

fs.writeFileSync(DETAIL_LOG_PATH, '');

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

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const SUPPORTED_IMAGE_MIME = new Set(Object.values(IMAGE_MIME_BY_EXT));
const MAX_TOOL_OUTPUT_LENGTH = 2000;

function resolveImageMimeType(filePath: string, mimeType?: string): string | null {
  if (mimeType) {
    const normalized = mimeType.split(';')[0].trim().toLowerCase();
    if (SUPPORTED_IMAGE_MIME.has(normalized)) {
      return normalized;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || null;
}

async function buildClaudeUserContent(prompt: string, inputImages?: InputImage[]): Promise<any[]> {
  const content: any[] = [];
  const normalizedPrompt = prompt.trim();
  content.push({
    type: 'text',
    text: normalizedPrompt || '请结合用户发送的图片内容进行分析并回复。',
  });

  for (const image of inputImages || []) {
    if (!fs.existsSync(image.filePath)) {
      continue;
    }

    try {
      const bytes = await fs.promises.readFile(image.filePath);
      const mimeType = resolveImageMimeType(image.filePath, image.mimeType);
      if (!mimeType) {
        logDetail('image.unsupported', { filePath: image.filePath, mimeType: image.mimeType || null });
        continue;
      }

      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: bytes.toString('base64'),
        },
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      logDetail('image.read.error', { filePath: image.filePath, error: errMsg });
    }
  }

  return content;
}

// 生成 streaming input 消息（MCP 工具/图片输入需要此格式）
async function* generateMessages(prompt: string, inputImages?: InputImage[]): AsyncGenerator<any> {
  const content = await buildClaudeUserContent(prompt, inputImages);
  yield {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractToolResultOutput(value: unknown): string {
  if (value == null) return '';

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const lines = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'type' in item && (item as any).type === 'text' && typeof (item as any).text === 'string') {
          return (item as any).text;
        }
        return safeJsonStringify(item);
      })
      .filter(Boolean);
    return lines.join('\n').trim();
  }

  if (typeof value === 'object') {
    const data = value as any;

    if (typeof data.content === 'string') {
      return data.content;
    }

    if (Array.isArray(data.content)) {
      const contentText = extractToolResultOutput(data.content);
      if (contentText) return contentText;
    }

    const stdout = typeof data.stdout === 'string' ? data.stdout : '';
    const stderr = typeof data.stderr === 'string' ? data.stderr : '';
    if (stdout || stderr) {
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      if (data.interrupted) parts.push('[interrupted]');
      return parts.join('\n\n').trim();
    }

    if (data.file?.filePath) {
      const file = data.file;
      const lineCount = file.numLines || file.totalLines || '?';
      return `📄 ${file.filePath} (${lineCount} 行)`;
    }
  }

  return safeJsonStringify(value);
}

function truncateToolOutput(output: string): string {
  if (!output) return '';
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_LENGTH)}\n... (输出已截断)`;
}

export interface StreamClaudeOptions {
  mcpServers?: Record<string, McpServer>;
  abortSignal?: AbortSignal;
  inputImages?: InputImage[];
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
  let currentToolId: string | null = null;
  let toolInput = '';
  let newSessionId: string | null = null;
  const emittedToolUseIds = new Set<string>();
  const emittedToolResultIds = new Set<string>();
  let sawStreamToolLifecycle = false;

  try {
    const useStreamingInput = Boolean(options?.mcpServers || (options?.inputImages?.length || 0) > 0);
    const promptInput = useStreamingInput
      ? generateMessages(prompt, options?.inputImages)
      : prompt;

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
          currentToolId = typeof event.content_block.id === 'string' ? event.content_block.id : null;
          if (currentToolId) {
            emittedToolUseIds.add(currentToolId);
          }
          sawStreamToolLifecycle = true;
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
          currentToolId = null;
          toolInput = '';
        }
      }

      // 完整 assistant 消息（某些 SDK 版本不会返回 stream_event，这里做兼容）
      if (message.type === 'assistant') {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type !== 'tool_use') continue;

            const toolUseId = typeof block.id === 'string' ? block.id : null;
            if (toolUseId && emittedToolUseIds.has(toolUseId)) {
              continue;
            }
            // 若已收到 stream_event，但块中缺少 tool_use_id，优先避免重复发送
            if (!toolUseId && sawStreamToolLifecycle) {
              continue;
            }

            if (toolUseId) {
              emittedToolUseIds.add(toolUseId);
            }

            const toolName = typeof block.name === 'string' ? block.name : '工具';
            const inputText = typeof block.input === 'string'
              ? block.input
              : safeJsonStringify(block.input || {});

            yield { type: 'tool_start', toolName };
            yield { type: 'tool_end', toolName, toolInput: inputText };
          }
        }
      }

      // 工具执行结果（优先解析 message.content 中的 tool_result）
      if (message.type === 'user') {
        const userMessageContent = (message as any).message?.content;
        let hasContentToolResult = false;

        if (Array.isArray(userMessageContent)) {
          for (const block of userMessageContent) {
            if (block?.type !== 'tool_result') continue;

            hasContentToolResult = true;
            const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
            if (toolUseId && emittedToolResultIds.has(toolUseId)) {
              continue;
            }

            let output = extractToolResultOutput(block.content);
            if (block.is_error === true && output) {
              output = `[工具错误]\n${output}`;
            }
            output = truncateToolOutput(output);
            if (!output) continue;

            if (toolUseId) {
              emittedToolResultIds.add(toolUseId);
            }
            yield { type: 'tool_result', toolOutput: output };
          }
        }

        // 兼容旧字段：当 content 中没有 tool_result 时，回退到顶层 tool_use_result
        if (!hasContentToolResult) {
          const toolUseResult = (message as any).tool_use_result;
          if (toolUseResult) {
            let output = extractToolResultOutput(toolUseResult);
            if ((toolUseResult as any).is_error === true && output) {
              output = `[工具错误]\n${output}`;
            }
            output = truncateToolOutput(output);
            if (output) {
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
