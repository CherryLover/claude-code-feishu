#!/usr/bin/env node

/**
 * Codex CLI stdio MCP 服务器
 *
 * 这个文件专门处理 Codex CLI 的 MCP 集成（stdio 传输）。
 * 底层业务逻辑调用 feishu-actions.ts / feishu-api.ts，保持 MCP 层独立。
 *
 * 注意：这是独立入口点，需要自行处理环境变量加载。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';
import { sendFileToFeishu } from '../feishu/actions.js';
import {
  searchUser,
  sendMessageToUser,
  createTask,
  createCalendarEvent,
} from '../feishu/api.js';
import {
  createScheduleAction,
  deleteScheduleAction,
  disableScheduleAction,
  enableScheduleAction,
  listSchedulesAction,
  runScheduleNowAction,
  updateScheduleAction,
} from '../scheduler/actions.js';

// --- 重定向 console.log 到 stderr（Lark SDK 的 error 级日志用的是 console.log，会污染 stdout）---

const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
  console.error(...args);
};

interface LarkErrorLike {
  message?: string;
  response?: {
    status?: number;
    data?: {
      code?: number;
      msg?: string;
      error?: {
        log_id?: string;
      };
    };
  };
}

function formatLarkLog(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;

      const err = arg as LarkErrorLike;
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.msg || err?.message;
      const logId = err?.response?.data?.error?.log_id;

      if (status || code || msg) {
        return `${status ? `HTTP ${status} - ` : ''}${msg || '飞书请求失败'}${code !== undefined ? ` (code: ${code})` : ''}${logId ? ` | log_id: ${logId}` : ''}`;
      }

      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' | ');
}

const larkLogger = {
  error: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  warn: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  info: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  debug: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  trace: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
};

// --- 环境变量加载（独立进程需要自行处理）---

const __mcpFilename = fileURLToPath(import.meta.url);
const __mcpDirname = path.dirname(__mcpFilename);
const projectRoot = path.resolve(__mcpDirname, '..');
const envFilePath = path.join(projectRoot, '.env');

// 手动解析 .env 文件（不能用 dotenv v17，它会向 stdout 输出日志破坏 MCP 协议）
if (fs.existsSync(envFilePath)) {
  const envContent = fs.readFileSync(envFilePath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 去除引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // 不覆盖已有环境变量
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.error(`[Codex MCP] 已从 ${envFilePath} 加载环境变量`);
}

// --- 懒加载飞书客户端 ---

let larkClient: Lark.Client | null = null;

function getLarkClient(): Lark.Client {
  if (!larkClient) {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('缺少飞书配置: FEISHU_APP_ID, FEISHU_APP_SECRET');
    }
    larkClient = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      // 禁用 SDK 的 info 日志，避免污染 stdout（破坏 MCP stdio 协议）
      loggerLevel: Lark.LoggerLevel.error,
      logger: larkLogger,
    });
    console.error('[Codex MCP] 飞书客户端初始化成功');
  }
  return larkClient;
}

// --- 创建 MCP 服务器 ---

const server = new McpServer({
  name: 'feishu-tools',
  version: '1.0.0',
});

// 工具 1: 发送文件
server.tool(
  'send_file_to_user',
  '发送本地文件给用户。支持图片（PNG/JPG/GIF等）、文档（PDF/DOC/XLS/PPT等）、音频（MP3/WAV等）。可传 chat_id 发送到会话，或传 open_id 直接发给指定用户。',
  {
    file_path: z.string().describe('文件的绝对路径'),
    chat_id: z.string().optional().describe('目标飞书聊天 ID（可选）'),
    open_id: z.string().optional().describe('目标用户 open_id（可选，传入时优先按私聊发送）'),
    message: z.string().optional().describe('附带的说明文字（可选）'),
  },
  async (args) => {
    const { file_path: filePath, chat_id: chatId, open_id: openId, message } = args;
    const targetOpenId = openId?.trim();
    const targetChatId = chatId?.trim();
    const receiveIdType: 'chat_id' | 'open_id' = targetOpenId ? 'open_id' : 'chat_id';
    const receiveId = targetOpenId || targetChatId;

    if (!receiveId) {
      return {
        content: [{ type: 'text' as const, text: '错误：缺少接收方参数，请提供 open_id 或 chat_id。' }],
      };
    }

    const client = getLarkClient();
    const result = await sendFileToFeishu(
      client,
      receiveId,
      filePath,
      message,
      '[Codex MCP]',
      receiveIdType,
    );

    return {
      content: [{ type: 'text' as const, text: result.message }],
    };
  }
);

// 工具 2: 搜索用户
server.tool(
  'search_user',
  '在组织通讯录中搜索用户。支持按姓名模糊搜索，或按邮箱、手机号精确查找。返回用户的 open_id、姓名等信息。发送消息、创建任务、创建日程前，必须先用此工具获取目标用户的 open_id。',
  {
    query: z.string().describe('搜索关键词：用户姓名、邮箱或手机号'),
  },
  async (args) => {
    const client = getLarkClient();
    const result = await searchUser(client, args.query, '[Codex MCP]');
    let text: string;
    if (result.users.length > 0) {
      const userLines = result.users.map((u, i) =>
        `${i + 1}. ${u.name} (open_id: ${u.open_id})${u.email ? ` | 邮箱: ${u.email}` : ''}${u.mobile ? ` | 手机: ${u.mobile}` : ''}`
      );
      text = `${result.message}\n\n${userLines.join('\n')}`;
    } else {
      text = result.message;
    }
    return { content: [{ type: 'text' as const, text }] };
  }
);

// 工具 3: 发送私聊消息
server.tool(
  'send_message_to_user',
  '给指定用户发送飞书私聊消息。需要先通过 search_user 获取用户的 open_id。',
  {
    open_id: z.string().describe('目标用户的 open_id（通过 search_user 获取）'),
    content: z.string().describe('消息内容（纯文本）'),
  },
  async (args) => {
    const client = getLarkClient();
    const result = await sendMessageToUser(
      client,
      args.open_id,
      args.content,
      '[Codex MCP]'
    );
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// 工具 4: 创建待办任务
server.tool(
  'create_task',
  '创建飞书待办任务并指派给用户。需要先通过 search_user 获取用户的 open_id。',
  {
    title: z.string().describe('任务标题'),
    assignee_open_id: z.string().describe('执行者的 open_id'),
    due_date: z.string().optional().describe('截止日期，ISO 8601 格式，如 2025-01-20'),
    description: z.string().optional().describe('任务描述'),
  },
  async (args) => {
    const client = getLarkClient();
    const result = await createTask(
      client,
      {
        title: args.title,
        assignee_open_id: args.assignee_open_id,
        due_date: args.due_date,
        description: args.description,
      },
      '[Codex MCP]'
    );
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// 工具 5: 创建日程
server.tool(
  'create_calendar_event',
  '创建飞书日程并邀请参与者。需要先通过 search_user 获取参与者的 open_id。',
  {
    title: z.string().describe('日程标题'),
    start_time: z.string().describe('开始时间，ISO 8601 格式，如 2025-01-20T15:00:00+08:00'),
    end_time: z.string().optional().describe('结束时间（默认开始时间后 1 小时）'),
    attendee_open_ids: z.array(z.string()).describe('参与者 open_id 列表'),
    description: z.string().optional().describe('日程描述'),
    need_meeting: z.boolean().optional().describe('是否创建视频会议，默认 true'),
  },
  async (args) => {
    const client = getLarkClient();
    const result = await createCalendarEvent(
      client,
      {
        title: args.title,
        start_time: args.start_time,
        end_time: args.end_time,
        attendee_open_ids: args.attendee_open_ids,
        description: args.description,
        need_meeting: args.need_meeting,
      },
      '[Codex MCP]'
    );
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

server.tool(
  'schedule_list',
  '查看当前所有定时任务。适用于用户询问“有哪些定时”“查看日报定时”“当前有哪些周期任务”。',
  {
    include_disabled: z.boolean().optional().describe('是否包含已停用任务，默认 true'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: listSchedulesAction(args.include_disabled !== false) }],
  })
);

server.tool(
  'schedule_create',
  '创建新的定时任务。适用于每天/每周/周期性执行某件事，并把结果主动推送到飞书。若当前上下文未自动提供目标或工作目录，请显式传 target_id 和 working_directory。',
  {
    id: z.string().optional().describe('可选，任务 ID；不传则根据名称自动生成'),
    name: z.string().describe('任务名称，例如“日报推送”'),
    cron: z.string().describe('cron 表达式，例如“0 30 9 * * 1-5”表示工作日 9:30'),
    timezone: z.string().optional().describe('时区，默认 Asia/Shanghai'),
    prompt: z.string().describe('到点后真正执行的 AI 指令内容'),
    target_type: z.enum(['chat_id', 'open_id']).optional().describe('结果发送目标类型，默认 chat_id'),
    target_id: z.string().optional().describe('结果发送目标 ID'),
    working_directory: z.string().optional().describe('执行目录'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: createScheduleAction(args, { client: getLarkClient() }) }],
  })
);

server.tool(
  'schedule_update',
  '更新已有定时任务。适用于修改 cron、执行内容、发送目标或工作目录。',
  {
    id: z.string().describe('要更新的任务 ID'),
    name: z.string().optional().describe('新的任务名称'),
    cron: z.string().optional().describe('新的 cron 表达式'),
    timezone: z.string().optional().describe('新的时区'),
    prompt: z.string().optional().describe('新的 AI 执行内容'),
    target_type: z.enum(['chat_id', 'open_id']).optional().describe('新的结果发送目标类型'),
    target_id: z.string().optional().describe('新的结果发送目标 ID'),
    working_directory: z.string().optional().describe('新的执行目录'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: updateScheduleAction(args, { client: getLarkClient() }) }],
  })
);

server.tool(
  'schedule_enable',
  '启用一个已停用的定时任务。',
  {
    id: z.string().describe('任务 ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: enableScheduleAction(args.id) }],
  })
);

server.tool(
  'schedule_disable',
  '停用一个定时任务，但保留配置和历史记录。',
  {
    id: z.string().describe('任务 ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: disableScheduleAction(args.id) }],
  })
);

server.tool(
  'schedule_delete',
  '删除一个定时任务。',
  {
    id: z.string().describe('任务 ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: deleteScheduleAction(args.id) }],
  })
);

server.tool(
  'schedule_run_now',
  '立即执行一个已有定时任务，并把结果发送到它配置的飞书目标。',
  {
    id: z.string().describe('任务 ID'),
  },
  async (args) => ({
    content: [{ type: 'text' as const, text: await runScheduleNowAction(args.id, { client: getLarkClient() }) }],
  })
);

// --- 启动 stdio 传输 ---

async function main() {
  // 捕获未处理的异常和 rejection，防止进程意外退出
  process.on('uncaughtException', (err) => {
    console.error('[Codex MCP] 未捕获的异常:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[Codex MCP] 未处理的 Promise rejection:', reason);
  });

  const transport = new StdioServerTransport();

  // 监听传输层关闭事件
  transport.onclose = () => {
    console.error('[Codex MCP] 传输层关闭');
  };

  await server.connect(transport);
  console.error('[Codex MCP] feishu-tools stdio 服务器已启动');

  // MCP SDK 的 StdioServerTransport 会保持进程运行
}

main().catch((err) => {
  console.error('[Codex MCP] 启动失败:', err);
  process.exit(1);
});
