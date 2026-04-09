/**
 * 单文件 AI Agent Demo
 *
 * 核心：循环执行 + 工具调用 + 交互式对话
 * 运行：npx tsx src/agent/demo.ts
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import * as readline from 'readline';

// ─── 启动问候语 ─────────────────────────────────────────

const GREETINGS = [
  '你好！我是你的 AI 助手，有什么我可以帮你的吗？',
  '嗨！我准备好了，随时可以开始工作。有什么需要尽管说～',
  '早上好！今天有什么想做的？',
  '你好呀！我是你的命令行助手，来试试吧～',
  '启动完成！我在这里待命，随时听候差遣。',
];

function getRandomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

// ─── 配置 ───────────────────────────────────────────────

const client = new OpenAI({
  apiKey: process.env.AGENT_API_KEY,
  baseURL: process.env.AGENT_BASE_URL,
});

const MODEL = process.env.AGENT_MODEL || 'MiniMax-M2.7-highspeed';

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools.
You can execute shell commands, read and write files to help the user.
Working directory: ${process.cwd()}
Always respond in the user's language.`;

// ─── 工具定义 ────────────────────────────────────────────

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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

// ─── 工具执行 ────────────────────────────────────────────

function executeTool(name: string, args: Record<string, unknown>): string {
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

// ─── Agent 循环 ──────────────────────────────────────────

const conversationHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

async function agentLoop(userMessage: string): Promise<void> {
  conversationHistory.push({ role: 'user', content: userMessage });

  let step = 0;
  const maxSteps = 30;

  while (step < maxSteps) {
    step++;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory,
      ],
      tools,
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

      const result = executeTool(fnName, fnArgs);
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
  console.log(`💬 ${getRandomGreeting()}`);
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
