import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { ClaudeEvent, InputImage, StreamChatOptions } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// 详细日志文件路径
const LOG_DIR = path.join(PROJECT_ROOT, 'log');
const DETAIL_LOG_PATH = path.join(LOG_DIR, 'codex-detail.log');
const MCP_SERVER_SECTION = 'mcp_servers.feishu-tools';

// 确保 log 目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

console.log(`[Codex] 详细日志路径: ${DETAIL_LOG_PATH}`);

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
  try {
    fs.appendFileSync(DETAIL_LOG_PATH, line);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : '未知错误';
    console.error(`[Codex] 写入详情日志失败 (${DETAIL_LOG_PATH}):`, errMsg);
  }
}

logDetail('service.boot', {
  pid: process.pid,
  cwd: process.cwd(),
  workspace: config.workspace,
  nodePath: process.execPath,
});

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeSection(section: string | null): string {
  if (!section) return '';
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function extractTomlSection(configText: string, sectionName: string): string | null {
  const header = `[${sectionName}]`;
  const lines = configText.split(/\r?\n/);
  const sectionLines: string[] = [];
  let inTarget = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = trimmed.startsWith('[') && trimmed.endsWith(']');

    if (!inTarget) {
      if (trimmed === header) {
        inTarget = true;
        sectionLines.push(line.trimEnd());
      }
      continue;
    }

    if (isHeader) {
      break;
    }

    sectionLines.push(line.trimEnd());
  }

  return sectionLines.length > 0 ? sectionLines.join('\n').trimEnd() : null;
}

function upsertTomlSection(configText: string, sectionName: string, sectionBody: string): string {
  const header = `[${sectionName}]`;
  const lines = configText.split(/\r?\n/);
  const keptLines: string[] = [];
  let inTarget = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = trimmed.startsWith('[') && trimmed.endsWith(']');

    if (!inTarget && trimmed === header) {
      inTarget = true;
      continue;
    }

    if (inTarget && isHeader) {
      inTarget = false;
      keptLines.push(line.trimEnd());
      continue;
    }

    if (!inTarget) {
      keptLines.push(line.trimEnd());
    }
  }

  const withoutTarget = keptLines.join('\n').trimEnd();
  return `${withoutTarget ? `${withoutTarget}\n\n` : ''}${sectionBody.trimEnd()}\n`;
}

function getRuntimePaths() {
  return {
    projectRoot: PROJECT_ROOT,
    mcpServerPath: path.join(PROJECT_ROOT, 'dist', 'tools', 'mcp-server.js'),
    codexConfigPath: path.join(process.env.HOME || '/root', '.codex', 'config.toml'),
    nodePath: process.execPath,
  };
}

function resolveWorkingDirectory(preferredWorkingDirectory?: string): string {
  if (preferredWorkingDirectory) {
    fs.mkdirSync(preferredWorkingDirectory, { recursive: true });
  }

  const configuredWorkspaceExists = dirExists(config.workspace);

  const candidates = [
    preferredWorkingDirectory,
    config.workspace,
    process.cwd(),
    PROJECT_ROOT,
  ];
  const uniqueCandidates = [
    ...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))),
  ];
  const resolved = uniqueCandidates.find((candidate) => dirExists(candidate));

  logDetail('workspace.resolve', {
    preferredWorkingDirectory: preferredWorkingDirectory || null,
    configuredWorkspace: config.workspace,
    candidates: uniqueCandidates.map((candidate) => ({
      path: candidate,
      exists: dirExists(candidate),
    })),
    selected: resolved || null,
  });

  if (!resolved) {
    throw new Error(`未找到可用工作目录，请检查 WORKSPACE 配置。当前 WORKSPACE=${config.workspace}`);
  }

  const usingPreferredWorkingDirectory = Boolean(
    preferredWorkingDirectory && resolved === preferredWorkingDirectory,
  );

  if (!configuredWorkspaceExists && !usingPreferredWorkingDirectory && resolved !== config.workspace) {
    console.warn(`[Codex] WORKSPACE 不存在 (${config.workspace})，已回退到: ${resolved}`);
  }

  return resolved;
}

function buildOsErrorHint(errMsg: string, workingDirectory: string): string | null {
  if (!errMsg.includes('No such file or directory (os error 2)')) {
    return null;
  }

  const { mcpServerPath, codexConfigPath, nodePath } = getRuntimePaths();
  const problems: string[] = [];

  if (!dirExists(workingDirectory)) {
    problems.push(`工作目录不存在: ${workingDirectory}`);
  }
  if (!fileExists(nodePath)) {
    problems.push(`Node 可执行文件不存在: ${nodePath}`);
  }
  if (!fileExists(mcpServerPath)) {
    problems.push(`MCP 入口文件不存在: ${mcpServerPath}`);
  }
  if (!fileExists(codexConfigPath)) {
    problems.push(`Codex 配置文件不存在: ${codexConfigPath}`);
  }

  if (problems.length === 0) {
    return `请检查 Codex MCP 配置与 WORKSPACE。详细诊断见 ${DETAIL_LOG_PATH}`;
  }

  return `${problems.join('；')}。详细诊断见 ${DETAIL_LOG_PATH}`;
}

type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

const CODEX_SANDBOX_MODE = 'danger-full-access';
const CODEX_APPROVAL_POLICY = 'never';

function buildCodexTurnInput(prompt: string, inputImages?: InputImage[]): string | CodexInputItem[] {
  const validImages = (inputImages || []).filter((item) => fileExists(item.filePath));
  if (validImages.length === 0) {
    return prompt;
  }

  const items: CodexInputItem[] = [];
  const normalizedPrompt = prompt.trim();
  items.push({
    type: 'text',
    text: normalizedPrompt || '请结合用户发送的图片内容进行分析并回复。',
  });

  for (const image of validImages) {
    items.push({ type: 'local_image', path: image.filePath });
  }

  return items;
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
  const { projectRoot, mcpServerPath, codexConfigPath, nodePath } = getRuntimePaths();
  const codexConfigDir = path.dirname(codexConfigPath);

  logDetail('mcp.ensure.start', {
    projectRoot,
    mcpServerPath,
    mcpServerExists: fileExists(mcpServerPath),
    codexConfigPath,
    codexConfigExists: fileExists(codexConfigPath),
    nodePath,
    nodeExists: fileExists(nodePath),
  });

  if (!fileExists(mcpServerPath)) {
    const msg = `[Codex] MCP 入口文件不存在，跳过注册: ${mcpServerPath}`;
    console.error(msg);
    logDetail('mcp.ensure.skip', { reason: 'mcp_server_missing', mcpServerPath });
    return;
  }

  try {
    if (!dirExists(codexConfigDir)) {
      fs.mkdirSync(codexConfigDir, { recursive: true });
    }

    if (!fileExists(codexConfigPath)) {
      fs.writeFileSync(codexConfigPath, '', 'utf-8');
    }

    const currentConfig = fs.readFileSync(codexConfigPath, 'utf-8');
    const desiredSection = [
      `[${MCP_SERVER_SECTION}]`,
      `command = "${escapeTomlString(nodePath)}"`,
      `args = ["${escapeTomlString(mcpServerPath)}"]`,
      `cwd = "${escapeTomlString(projectRoot)}"`,
    ].join('\n');

    const currentSection = extractTomlSection(currentConfig, MCP_SERVER_SECTION);
    if (normalizeSection(currentSection) === normalizeSection(desiredSection)) {
      console.log(`[Codex] MCP feishu-tools 已注册: ${mcpServerPath}`);
      logDetail('mcp.ensure.unchanged', { codexConfigPath });
      return;
    }

    const nextConfig = upsertTomlSection(currentConfig, MCP_SERVER_SECTION, desiredSection);
    fs.writeFileSync(codexConfigPath, nextConfig, 'utf-8');

    console.log(`[Codex] MCP feishu-tools 注册成功: ${mcpServerPath} (cwd: ${projectRoot})`);
    logDetail('mcp.ensure.updated', {
      codexConfigPath,
      section: desiredSection,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : '未知错误';
    console.error(`[Codex] MCP feishu-tools 注册失败: ${errMsg}`);
    logDetail('mcp.ensure.error', {
      message: errMsg,
      stack: err instanceof Error ? err.stack : undefined,
      codexConfigPath,
    });
  }
}

async function getCodex(): Promise<any> {
  if (!codexInstance) {
    // Codex CLI 优先使用 CODEX_API_KEY 进行认证
    // 如果只设置了 OPENAI_API_KEY，复制到 CODEX_API_KEY 确保认证正常
    if (!process.env.CODEX_API_KEY && process.env.OPENAI_API_KEY) {
      process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
    }

    logDetail('codex.init', {
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
      hasCodexKey: Boolean(process.env.CODEX_API_KEY),
      baseUrl: process.env.OPENAI_BASE_URL || null,
    });

    // 注册 MCP 服务器到 Codex 全局配置
    ensureMcpServerRegistered();

    const { Codex } = await import('@openai/codex-sdk');
    codexInstance = new Codex({
      config: {
        sandbox_mode: CODEX_SANDBOX_MODE,
        approval_policy: CODEX_APPROVAL_POLICY,
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
  let workingDirectory = config.workspace;

  try {
    workingDirectory = resolveWorkingDirectory(options?.workingDirectory);
    const turnInput = buildCodexTurnInput(prompt, options?.inputImages);
    const inputImageCount = options?.inputImages?.length || 0;

    logDetail('turn.start', {
      sessionId,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 200),
      workingDirectory,
      configuredWorkspace: config.workspace,
      preferredWorkingDirectory: options?.workingDirectory || null,
      inputImageCount,
    });

    let thread;
    if (sessionId) {
      console.log(`[Codex] 恢复线程: ${sessionId}`);
      thread = codex.resumeThread(sessionId, {
        workingDirectory,
        sandboxMode: CODEX_SANDBOX_MODE,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        skipGitRepoCheck: true,
      });
    } else {
      console.log(`[Codex] 创建新线程`);
      thread = codex.startThread({
        workingDirectory,
        sandboxMode: CODEX_SANDBOX_MODE,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        skipGitRepoCheck: true,
      });
    }

    const { events } = await thread.runStreamed(turnInput, {
      signal: options?.abortSignal,
    });

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
              yield { type: 'text', content: text };
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
          logDetail('turn.failed', {
            message: errMsg,
            event: evt,
            sessionId,
            workingDirectory,
          });
          yield { type: 'error', content: errMsg };
          break;
        }

        case 'error': {
          const errMsg = evt.message || evt.error?.message || '未知错误';
          console.log(`[Codex] 错误: ${errMsg}`);
          logDetail('turn.error', {
            message: errMsg,
            event: evt,
            sessionId,
            workingDirectory,
          });
          yield { type: 'error', content: errMsg };
          break;
        }
      }
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    const { projectRoot, mcpServerPath, codexConfigPath, nodePath } = getRuntimePaths();

    logDetail('turn.exception', {
      message: errMsg,
      stack: error instanceof Error ? error.stack : undefined,
      sessionId,
      configuredWorkspace: config.workspace,
      resolvedWorkingDirectory: workingDirectory,
      workingDirectoryExists: dirExists(workingDirectory),
      processCwd: process.cwd(),
      projectRoot,
      mcpServerPath,
      mcpServerExists: fileExists(mcpServerPath),
      codexConfigPath,
      codexConfigExists: fileExists(codexConfigPath),
      mcpSection: fileExists(codexConfigPath)
        ? extractTomlSection(fs.readFileSync(codexConfigPath, 'utf-8'), MCP_SERVER_SECTION)
        : null,
      nodePath,
      nodeExists: fileExists(nodePath),
    });

    const hint = buildOsErrorHint(errMsg, workingDirectory);
    yield { type: 'error', content: hint ? `${errMsg}\n${hint}` : errMsg };
  }
}
