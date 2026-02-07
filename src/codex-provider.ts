import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { config } from './config.js';
import { ClaudeEvent, StreamChatOptions } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 详细日志文件路径
const LOG_DIR = path.resolve(process.cwd(), 'log');
const DETAIL_LOG_PATH = path.join(LOG_DIR, 'codex-detail.log');

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
    if (err) console.error('[Codex] 写入详情日志失败:', err.message);
  });
}

// Codex SDK 是 ESM-only，需要动态 import
let codexInstance: any = null;

/**
 * 确保 feishu-tools MCP 服务器已注册到 Codex 全局配置。
 * Codex CLI 在启动时读 ~/.codex/config.toml 发现 MCP 服务器，
 * 通过 SDK config (--config) 覆盖的方式无法触发 MCP 服务器启动。
 *
 * 注意：需要在配置中设置 cwd 让 MCP 服务器能找到 .env 文件。
 */
function ensureMcpServerRegistered(): void {
  // 始终指向编译后的 dist/mcp-server.js，无论当前是 dev(tsx/src) 还是 prod(node/dist) 模式
  const projectRoot = path.resolve(__dirname, '..');
  const mcpServerPath = path.join(projectRoot, 'dist', 'mcp-server.js');
  const codexConfigPath = path.join(process.env.HOME || '/root', '.codex', 'config.toml');

  // 读取现有配置
  let currentConfig = '';
  if (fs.existsSync(codexConfigPath)) {
    currentConfig = fs.readFileSync(codexConfigPath, 'utf-8');
  }

  // 检查是否需要更新（路径或 cwd 不对）
  const hasCorrectPath = currentConfig.includes(mcpServerPath);
  const hasCorrectCwd = currentConfig.includes(`cwd = "${projectRoot}"`);

  if (hasCorrectPath && hasCorrectCwd) {
    console.log(`[Codex] MCP feishu-tools 已注册: ${mcpServerPath}`);
    return;
  }

  // 需要更新配置
  try {
    // 先移除旧配置
    try { execSync('codex mcp remove feishu-tools', { stdio: 'ignore' }); } catch { /* ignore */ }

    // 重新读取配置（移除后）
    currentConfig = fs.existsSync(codexConfigPath)
      ? fs.readFileSync(codexConfigPath, 'utf-8')
      : '';

    // 手动追加 MCP 服务器配置，包含 cwd 设置
    const mcpConfig = `
[mcp_servers.feishu-tools]
command = "node"
args = ["${mcpServerPath}"]
cwd = "${projectRoot}"
`;

    fs.appendFileSync(codexConfigPath, mcpConfig);
    console.log(`[Codex] MCP feishu-tools 注册成功: ${mcpServerPath} (cwd: ${projectRoot})`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : '未知错误';
    console.error(`[Codex] MCP feishu-tools 注册失败: ${errMsg}`);
  }
}

async function getCodex(): Promise<any> {
  if (!codexInstance) {
    // Codex CLI 优先使用 CODEX_API_KEY 进行认证
    // 如果只设置了 OPENAI_API_KEY，复制到 CODEX_API_KEY 确保认证正常
    if (!process.env.CODEX_API_KEY && process.env.OPENAI_API_KEY) {
      process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
    }

    // 注册 MCP 服务器到 Codex 全局配置
    ensureMcpServerRegistered();

    const { Codex } = await import('@openai/codex-sdk');
    codexInstance = new Codex({
      config: {
        sandbox_mode: 'workspace-write',
        approval_policy: 'never',
      },
    });
  }
  return codexInstance;
}

export async function* streamCodexChat(
  prompt: string,
  sessionId: string | null,
  options?: StreamChatOptions,
): AsyncGenerator<ClaudeEvent> {
  const codex = await getCodex();

  try {
    let thread;
    if (sessionId) {
      console.log(`[Codex] 恢复线程: ${sessionId}`);
      thread = codex.resumeThread(sessionId, {
        workingDirectory: config.workspace,
        skipGitRepoCheck: true,
      });
    } else {
      console.log(`[Codex] 创建新线程`);
      thread = codex.startThread({
        workingDirectory: config.workspace,
        skipGitRepoCheck: true,
      });
    }

    const { events } = await thread.runStreamed(prompt);

    let threadId: string | null = null;
    const agentMessages: string[] = [];

    for await (const event of events) {
      if (options?.abortSignal?.aborted) {
        return;
      }

      const evt = event as any;

      logDetail(event.type, evt);

      switch (event.type) {
        case 'thread.started': {
          threadId = evt.thread_id || null;
          console.log(`[Codex] 线程 ID: ${threadId}`);
          break;
        }

        case 'item.started': {
          const item = evt.item;
          if (!item) break;

          if (item.type === 'command_execution') {
            console.log(`[Codex] 工具调用: Bash`);
            yield { type: 'tool_start', toolName: 'Bash' };
          } else if (item.type === 'file_change') {
            console.log(`[Codex] 工具调用: Edit`);
            yield { type: 'tool_start', toolName: 'Edit' };
          } else if (item.type === 'mcp_tool_call') {
            const toolName = `MCP:${item.server}/${item.tool}`;
            console.log(`[Codex] MCP 工具调用: ${toolName}`);
            yield { type: 'tool_start', toolName };
          }
          break;
        }

        case 'item.completed': {
          const item = evt.item;
          if (!item) break;

          if (item.type === 'command_execution') {
            console.log(`[Codex] Bash 完成: ${(item.command || '').slice(0, 80)}`);
            yield {
              type: 'tool_end',
              toolName: 'Bash',
              toolInput: JSON.stringify({ command: item.command || '' }),
            };
            const output = item.aggregated_output || item.output || '';
            if (output) {
              yield { type: 'tool_result', toolOutput: output };
            }
          } else if (item.type === 'file_change') {
            const filePath = item.file_path || item.path || item.file || '';
            console.log(`[Codex] Edit 完成: ${filePath}`);
            yield {
              type: 'tool_end',
              toolName: 'Edit',
              toolInput: JSON.stringify({ file_path: filePath }),
            };
            const diff = item.diff || item.changes || '';
            const diffStr = typeof diff === 'string' ? diff : JSON.stringify(diff);
            if (diffStr) {
              yield { type: 'tool_result', toolOutput: diffStr };
            }
          } else if (item.type === 'mcp_tool_call') {
            const toolName = `MCP:${item.server}/${item.tool}`;
            const args = typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {});
            console.log(`[Codex] MCP 完成: ${toolName}`);
            yield {
              type: 'tool_end',
              toolName,
              toolInput: args,
            };
            // 输出结果或错误
            if (item.error) {
              yield { type: 'tool_result', toolOutput: `错误: ${item.error.message}` };
            } else if (item.result) {
              const resultText = item.result.content
                ?.map((c: any) => c.text || JSON.stringify(c))
                .join('\n') || '';
              if (resultText) {
                yield { type: 'tool_result', toolOutput: resultText };
              }
            }
          } else if (item.type === 'reasoning') {
            if (item.text) {
              console.log(`[Codex] 思考中...`);
              yield { type: 'tool_start', toolName: 'Reasoning' };
              yield {
                type: 'tool_end',
                toolName: 'Reasoning',
                toolInput: JSON.stringify({ reasoning: item.text }),
              };
            }
          } else if (item.type === 'agent_message') {
            const text = item.text || '';
            if (text) {
              console.log(`[Codex] 收到回复 (${text.length} 字符)`);
              agentMessages.push(text);
            }
          }
          break;
        }

        case 'turn.completed': {
          console.log(`[Codex] 处理完成`);
          const finalContent = agentMessages[agentMessages.length - 1] || '';

          const usage = evt.usage;
          yield {
            type: 'result',
            content: finalContent,
            sessionId: threadId || sessionId || undefined,
            usage: usage ? {
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
            } : undefined,
          };
          break;
        }

        case 'turn.failed': {
          const errMsg = evt.error?.message || evt.message || '处理失败';
          console.log(`[Codex] 处理失败: ${errMsg}`);
          yield { type: 'error', content: errMsg };
          break;
        }

        case 'error': {
          const errMsg = evt.message || evt.error?.message || '未知错误';
          console.log(`[Codex] 错误: ${errMsg}`);
          yield { type: 'error', content: errMsg };
          break;
        }
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    yield { type: 'error', content: errMsg };
  }
}
