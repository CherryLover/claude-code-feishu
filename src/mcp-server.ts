#!/usr/bin/env node

/**
 * Codex CLI stdio MCP 服务器
 *
 * 这个文件专门处理 Codex CLI 的 MCP 集成（stdio 传输）。
 * 底层业务逻辑调用 feishu-actions.ts，保持 MCP 层独立。
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
import { sendFileToFeishu } from './feishu-actions.js';

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

server.tool(
  'send_file_to_user',
  '发送本地文件给用户。支持图片（PNG/JPG/GIF等）、文档（PDF/DOC/XLS/PPT等）、音频（MP3/WAV等）。当用户请求查看文件、要求发送文件、或者生成了需要展示的文件时，使用此工具发送给用户。',
  {
    file_path: z.string().describe('文件的绝对路径'),
    chat_id: z.string().describe('目标飞书聊天 ID（从系统提示中获取）'),
    message: z.string().optional().describe('附带的说明文字（可选）'),
  },
  async (args) => {
    const { file_path: filePath, chat_id: chatId, message } = args;

    const client = getLarkClient();
    const result = await sendFileToFeishu(
      client,
      chatId,
      filePath,
      message,
      '[Codex MCP]'
    );

    return {
      content: [{ type: 'text' as const, text: result.message }],
    };
  }
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
