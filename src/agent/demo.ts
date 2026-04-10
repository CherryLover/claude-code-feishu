/**
 * 单文件 AI Agent Demo
 *
 * 核心：循环执行 + 工具调用 + MCP 支持 + 交互式对话
 * 运行：npx tsx src/agent/demo.ts
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, resolve, join } from 'path';
import * as readline from 'readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ─── 配置 ───────────────────────────────────────────────

const client = new OpenAI({
  apiKey: process.env.AGENT_API_KEY,
  baseURL: process.env.AGENT_BASE_URL,
});

const MODEL = process.env.AGENT_MODEL || 'MiniMax-M2.7-highspeed';

function buildSystemPrompt(): string {
  let prompt = `You are a helpful AI assistant with access to tools.
You can execute shell commands, read and write files to help the user.
Working directory: ${process.cwd()}
Always respond in the user's language.`;
  if (skillInstructions) {
    prompt += `\n\nYou also have the following skills available. Use them when relevant:\n${skillInstructions}`;
  }
  return prompt;
}

// ─── 内置工具定义 ─────────────────────────────────────────

const builtinTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating directories if needed',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file. The old_string must match exactly (including whitespace and indentation). Use read_file first to see the current content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'The exact string to find and replace' },
          new_string: { type: 'string', description: 'The replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
];

// ─── 内置工具执行 ─────────────────────────────────────────

function executeBuiltinTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case 'bash': {
        const output = execSync(args.command as string, {
          encoding: 'utf-8',
          timeout: 30_000,
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output || '(no output)';
      }
      case 'read_file': {
        return readFileSync(args.path as string, 'utf-8');
      }
      case 'write_file': {
        const filePath = args.path as string;
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, args.content as string, 'utf-8');
        return `Written to ${filePath}`;
      }
      case 'edit_file': {
        const editPath = args.path as string;
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;
        const content = readFileSync(editPath, 'utf-8');
        if (!content.includes(oldStr)) {
          return `Error: old_string not found in ${editPath}`;
        }
        const count = content.split(oldStr).length - 1;
        if (count > 1) {
          return `Error: old_string matches ${count} times in ${editPath}, must be unique. Provide more surrounding context.`;
        }
        writeFileSync(editPath, content.replace(oldStr, newStr), 'utf-8');
        return `Edited ${editPath}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message || err}`;
  }
}

// ─── MCP 客户端管理 ──────────────────────────────────────

interface McpServerConfigStdio {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServerConfigHttp {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

type McpServerConfig = McpServerConfigStdio | McpServerConfigHttp;

interface AgentConfig {
  skillsDir?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

// 工具名 → MCP 客户端的映射
const mcpToolMap = new Map<string, Client>();
// 工具名 → MCP 原始工具名的映射
const mcpToolOriginalName = new Map<string, string>();
// 所有 MCP 客户端（用于关闭）
const mcpClients: Client[] = [];
// MCP 工具转成的 OpenAI 格式
let mcpTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

// ─── 统一配置加载 ────────────────────────────────────────

function loadAgentConfig(): AgentConfig {
  const configPath = resolve(process.cwd(), 'agent-config.json');
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

// ─── Skill 加载 ──────────────────────────────────────────

let skillInstructions = '';

function loadSkills(skillsDir: string): void {
  if (!existsSync(skillsDir)) {
    console.log(`  (skills dir not found: ${skillsDir})`);
    return;
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: { name: string; instructions: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    try {
      const content = readFileSync(skillMd, 'utf-8');
      const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+)$/m);
      const name = nameMatch?.[1]?.trim() || entry.name;
      skills.push({ name, instructions: content });
    } catch (err: any) {
      console.error(`  ✗ skill ${entry.name}: ${err.message}`);
    }
  }

  if (skills.length > 0) {
    skillInstructions = skills
      .map(s => `\n--- Skill: ${s.name} ---\n${s.instructions}`)
      .join('\n');
    console.log(`  ✓ skills: ${skills.length} loaded (${skills.map(s => s.name).join(', ')})`);
  }
}

// ─── MCP 加载 ────────────────────────────────────────────

async function loadMcpServers(mcpServers: Record<string, McpServerConfig>): Promise<void> {
  const serverEntries = Object.entries(mcpServers);

  if (serverEntries.length === 0) return;

  for (const [serverName, serverConfig] of serverEntries) {
    try {
      console.log(`  connecting to MCP server: ${serverName}...`);

      let transport;
      if (serverConfig.type === 'http') {
        transport = new StreamableHTTPClientTransport(
          new URL(serverConfig.url),
          {
            requestInit: serverConfig.headers
              ? { headers: serverConfig.headers }
              : undefined,
          },
        );
      } else {
        transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: { ...process.env, ...(serverConfig.env || {}) } as Record<string, string>,
        });
      }

      const mcpClient = new Client({
        name: `agent-demo/${serverName}`,
        version: '1.0.0',
      });

      await mcpClient.connect(transport);
      mcpClients.push(mcpClient);

      // 拉取工具列表
      const { tools: serverTools } = await mcpClient.listTools();

      for (const tool of serverTools) {
        // 加前缀避免和内置工具或其他 MCP 服务器的工具重名
        const toolName = `mcp__${serverName}__${tool.name}`;
        mcpToolMap.set(toolName, mcpClient);
        mcpToolOriginalName.set(toolName, tool.name);

        mcpTools.push({
          type: 'function',
          function: {
            name: toolName,
            description: `[MCP:${serverName}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema as any || { type: 'object', properties: {} },
          },
        });
      }

      console.log(`  ✓ ${serverName}: ${serverTools.length} tools loaded`);
    } catch (err: any) {
      console.error(`  ✗ ${serverName}: ${err.message || err}`);
    }
  }
}

async function executeMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const mcpClient = mcpToolMap.get(toolName);
  if (!mcpClient) return `Error: MCP tool not found: ${toolName}`;

  const originalName = mcpToolOriginalName.get(toolName)!;

  try {
    const result = await mcpClient.callTool({ name: originalName, arguments: args });
    // MCP 返回 content 数组，取第一个文本
    const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
    return textContent?.text || JSON.stringify(result.content);
  } catch (err: any) {
    return `Error: ${err.message || err}`;
  }
}

async function closeMcpClients(): Promise<void> {
  for (const c of mcpClients) {
    try { await c.close(); } catch { /* ignore */ }
  }
}

// ─── 统一工具执行 ────────────────────────────────────────

const BUILTIN_TOOLS = new Set(['bash', 'read_file', 'write_file', 'edit_file']);

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (BUILTIN_TOOLS.has(name)) {
    return executeBuiltinTool(name, args);
  }
  if (mcpToolMap.has(name)) {
    return executeMcpTool(name, args);
  }
  return `Unknown tool: ${name}`;
}

// ─── Agent 循环 ──────────────────────────────────────────

const conversationHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

async function agentLoop(userMessage: string): Promise<void> {
  conversationHistory.push({ role: 'user', content: userMessage });

  // 合并内置工具和 MCP 工具
  const allTools = [...builtinTools, ...mcpTools];

  let step = 0;
  const maxSteps = 30;

  while (step < maxSteps) {
    step++;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        ...conversationHistory,
      ],
      tools: allTools,
      max_tokens: 4096,
    });

    const choice = response.choices[0];
    const message = choice.message;

    // 把 assistant 的回复加入历史
    conversationHistory.push(message as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    // 如果有文本回复，打印出来
    if (message.content) {
      console.log(`\n${message.content}`);
    }

    // 没有工具调用 → 本轮结束
    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    // 执行每个工具调用
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      const fnArgs = JSON.parse(toolCall.function.arguments);

      console.log(`\n  [tool] ${fnName}: ${JSON.stringify(fnArgs).slice(0, 100)}`);

      const result = await executeTool(fnName, fnArgs);
      const preview = result.length > 200 ? result.slice(0, 200) + '...' : result;
      console.log(`  [result] ${preview}`);

      // 工具结果喂回 LLM
      conversationHistory.push({
        role: 'tool' as const,
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  if (step >= maxSteps) {
    console.log('\n(reached max steps, stopping)');
  }
}

// ─── 交互入口 ────────────────────────────────────────────

async function main() {
  console.log(`Agent ready | model: ${MODEL}`);

  // 加载配置
  const config = loadAgentConfig();

  // 加载 Skills
  if (config.skillsDir) {
    loadSkills(config.skillsDir);
  }

  // 加载 MCP 服务器
  if (config.mcpServers) {
    await loadMcpServers(config.mcpServers);
  }

  console.log('Type your message, /clear to reset, /exit to quit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === '/exit') {
      await closeMcpClients();
      console.log('Bye.');
      rl.close();
      process.exit(0);
    }

    if (input === '/clear') {
      conversationHistory.length = 0;
      console.log('History cleared.\n');
      rl.prompt();
      return;
    }

    try {
      await agentLoop(input);
    } catch (err: any) {
      console.error(`\nError: ${err.message || err}`);
    }

    console.log('');
    rl.prompt();
  });
}

main();
