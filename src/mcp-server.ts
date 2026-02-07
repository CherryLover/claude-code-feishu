#!/usr/bin/env node

/**
 * 独立的 stdio MCP 服务器，供 Codex CLI 子进程挂载使用。
 * 提供 send_file_to_user 工具，通过飞书 API 向用户发送文件。
 *
 * 环境变量：FEISHU_APP_ID, FEISHU_APP_SECRET
 * 优先从 process.env 读取，不存在时尝试加载项目 .env 文件。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as Lark from '@larksuiteoapi/node-sdk';

// MCP 服务器作为独立子进程运行，可能没有继承主进程的 .env 环境变量。
// 不能用 dotenv（v17 会向 stdout 输出日志，破坏 MCP stdio 协议），手动解析 .env 文件。
const __mcpFilename = fileURLToPath(import.meta.url);
const __mcpDirname = path.dirname(__mcpFilename);
const projectRoot = path.resolve(__mcpDirname, '..');
const envFilePath = path.join(projectRoot, '.env');

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
  console.error(`[MCP] 已从 ${envFilePath} 加载环境变量`);
}

// --- 文件分类逻辑（内联自 file-utils.ts，因为 MCP 服务器是独立入口点）---

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.amr'];
const FILE_TYPE_MAP: Record<string, string> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.mp4': 'mp4',
};

type FileCategory = 'image' | 'audio' | 'file';

function getFileCategory(filePath: string): FileCategory {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return 'file';
}

function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return FILE_TYPE_MAP[ext] || 'stream';
}

// --- 懒加载飞书客户端（避免启动时因缺环境变量而崩溃，导致 MCP 工具不可见）---

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
    console.error('[MCP] 飞书客户端初始化成功');
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

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: 'text' as const, text: `错误：文件不存在 - ${filePath}` }],
      };
    }

    // 检查文件大小（飞书限制：图片 10MB，文件 30MB）
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const category = getFileCategory(filePath);

    if (category === 'image' && fileSizeMB > 10) {
      return {
        content: [{ type: 'text' as const, text: `错误：图片文件超过 10MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）` }],
      };
    }
    if (fileSizeMB > 30) {
      return {
        content: [{ type: 'text' as const, text: `错误：文件超过 30MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）` }],
      };
    }

    try {
      const client = getLarkClient();
      const fileName = path.basename(filePath);

      if (category === 'image') {
        // 上传图片
        const uploadRes = await client.im.image.create({
          data: {
            image_type: 'message',
            image: fs.createReadStream(filePath),
          },
        });

        const imageKey = (uploadRes as any)?.image_key || (uploadRes as any)?.data?.image_key;
        if (!imageKey) {
          return {
            content: [{ type: 'text' as const, text: '错误：图片上传失败，未获取到 image_key' }],
          };
        }

        // 发送图片消息
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });

        console.error(`[MCP] 图片已发送: ${fileName}`);
        return {
          content: [{ type: 'text' as const, text: `图片 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
        };
      } else if (category === 'audio') {
        // 上传音频文件
        const uploadRes = await client.im.file.create({
          data: {
            file_type: 'opus',
            file_name: fileName,
            file: fs.createReadStream(filePath),
          },
        });

        const fileKey = (uploadRes as any)?.file_key || (uploadRes as any)?.data?.file_key;
        if (!fileKey) {
          return {
            content: [{ type: 'text' as const, text: '错误：音频上传失败，未获取到 file_key' }],
          };
        }

        // 发送音频消息
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'audio',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });

        console.error(`[MCP] 音频已发送: ${fileName}`);
        return {
          content: [{ type: 'text' as const, text: `音频 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
        };
      } else {
        // 上传普通文件
        const fileType = getFileType(filePath);
        const uploadRes = await client.im.file.create({
          data: {
            file_type: fileType as any,
            file_name: fileName,
            file: fs.createReadStream(filePath),
          },
        });

        const fileKey = (uploadRes as any)?.file_key || (uploadRes as any)?.data?.file_key;
        if (!fileKey) {
          return {
            content: [{ type: 'text' as const, text: '错误：文件上传失败，未获取到 file_key' }],
          };
        }

        // 发送文件消息
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });

        console.error(`[MCP] 文件已发送: ${fileName}`);
        return {
          content: [{ type: 'text' as const, text: `文件 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
        };
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      console.error(`[MCP] 文件发送失败: ${errMsg}`);
      return {
        content: [{ type: 'text' as const, text: `错误：文件发送失败 - ${errMsg}` }],
      };
    }
  }
);

// --- 启动 stdio 传输 ---

async function main() {
  // 捕获未处理的异常和 rejection，防止进程意外退出
  process.on('uncaughtException', (err) => {
    console.error('[MCP] 未捕获的异常:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[MCP] 未处理的 Promise rejection:', reason);
  });

  const transport = new StdioServerTransport();

  // 监听传输层关闭事件
  transport.onclose = () => {
    console.error('[MCP] 传输层关闭');
  };

  await server.connect(transport);
  console.error('[MCP] feishu-tools stdio 服务器已启动');

  // MCP SDK 的 StdioServerTransport 会保持进程运行
  // 不需要额外的保活逻辑
}

main().catch((err) => {
  console.error('[MCP] 启动失败:', err);
  process.exit(1);
});
