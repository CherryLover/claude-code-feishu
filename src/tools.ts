/**
 * Claude Agent SDK MCP 工具层
 *
 * 这个文件专门处理 Claude Agent SDK 的 MCP 集成。
 * 底层业务逻辑调用 feishu-actions.ts，保持 MCP 层独立。
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as Lark from '@larksuiteoapi/node-sdk';
import { sendFileToFeishu } from './feishu-actions.js';

export function createFeishuToolsServer(client: Lark.Client, chatId: string) {
  return createSdkMcpServer({
    name: 'feishu-tools',
    version: '1.0.0',
    tools: [
      tool(
        'send_file_to_user',
        '发送本地文件给用户。支持图片（PNG/JPG/GIF等）、文档（PDF/DOC/XLS/PPT等）、音频（MP3/WAV等）。当用户请求查看文件、要求发送文件、或者生成了需要展示的文件时，使用此工具发送给用户。',
        {
          file_path: z.string().describe('文件的绝对路径'),
          message: z.string().optional().describe('附带的说明文字（可选）'),
        },
        async (args) => {
          const result = await sendFileToFeishu(
            client,
            chatId,
            args.file_path,
            args.message,
            '[Claude工具]'
          );

          return {
            content: [{ type: 'text', text: result.message }],
          };
        }
      ),
    ],
  });
}
