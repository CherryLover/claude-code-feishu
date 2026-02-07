import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getFileCategory, getFileType } from './file-utils.js';

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
          const filePath = args.file_path;
          const message = args.message;

          // 检查文件是否存在
          if (!fs.existsSync(filePath)) {
            return {
              content: [{ type: 'text', text: `错误：文件不存在 - ${filePath}` }],
            };
          }

          // 检查文件大小（飞书限制：图片 10MB，文件 30MB）
          const stats = fs.statSync(filePath);
          const fileSizeMB = stats.size / (1024 * 1024);
          const category = getFileCategory(filePath);

          if (category === 'image' && fileSizeMB > 10) {
            return {
              content: [{ type: 'text', text: `错误：图片文件超过 10MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）` }],
            };
          }
          if (fileSizeMB > 30) {
            return {
              content: [{ type: 'text', text: `错误：文件超过 30MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）` }],
            };
          }

          try {
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
                  content: [{ type: 'text', text: '错误：图片上传失败，未获取到 image_key' }],
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

              console.log(`[工具] 图片已发送: ${fileName}`);
              return {
                content: [{ type: 'text', text: `图片 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
              };
            } else if (category === 'audio') {
              // 上传音频文件
              const uploadRes = await client.im.file.create({
                data: {
                  file_type: 'opus', // 飞书音频统一用 opus 类型
                  file_name: fileName,
                  file: fs.createReadStream(filePath),
                },
              });

              const fileKey = (uploadRes as any)?.file_key || (uploadRes as any)?.data?.file_key;
              if (!fileKey) {
                return {
                  content: [{ type: 'text', text: '错误：音频上传失败，未获取到 file_key' }],
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

              console.log(`[工具] 音频已发送: ${fileName}`);
              return {
                content: [{ type: 'text', text: `音频 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
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
                  content: [{ type: 'text', text: '错误：文件上传失败，未获取到 file_key' }],
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

              console.log(`[工具] 文件已发送: ${fileName}`);
              return {
                content: [{ type: 'text', text: `文件 "${fileName}" 已发送给用户${message ? `，说明：${message}` : ''}` }],
              };
            }
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : '未知错误';
            console.error(`[工具] 文件发送失败: ${errMsg}`);
            return {
              content: [{ type: 'text', text: `错误：文件发送失败 - ${errMsg}` }],
            };
          }
        }
      ),
    ],
  });
}
