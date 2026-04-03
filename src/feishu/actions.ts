/**
 * 飞书操作底层工具 - 供 Claude MCP 和 Codex MCP 共享
 *
 * 这个文件只包含纯业务逻辑，不涉及 MCP 协议相关内容。
 * MCP 层各自独立维护，方便排查问题。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { getFileCategory, getFileType } from '../tools/file-utils.js';

// 统一的返回类型
export interface ActionResult {
  success: boolean;
  message: string;
}

/**
 * 发送文件到飞书聊天
 *
 * @param client 飞书客户端实例
 * @param receiveId 目标接收方 ID（chat_id 或 open_id）
 * @param filePath 文件绝对路径
 * @param description 可选的说明文字
 * @param logPrefix 日志前缀，用于区分调用来源
 * @param receiveIdType 接收方 ID 类型
 */
export async function sendFileToFeishu(
  client: Lark.Client,
  receiveId: string,
  filePath: string,
  description?: string,
  logPrefix = '[飞书]',
  receiveIdType: 'chat_id' | 'open_id' = 'chat_id',
): Promise<ActionResult> {
  if (!receiveId) {
    return {
      success: false,
      message: '错误：缺少接收方 ID（chat_id 或 open_id）',
    };
  }

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      message: `错误：文件不存在 - ${filePath}`,
    };
  }

  // 检查文件大小（飞书限制：图片 10MB，文件 30MB）
  const stats = fs.statSync(filePath);
  const fileSizeMB = stats.size / (1024 * 1024);
  const category = getFileCategory(filePath);

  if (category === 'image' && fileSizeMB > 10) {
    return {
      success: false,
      message: `错误：图片文件超过 10MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）`,
    };
  }
  if (fileSizeMB > 30) {
    return {
      success: false,
      message: `错误：文件超过 30MB 限制（当前 ${fileSizeMB.toFixed(2)}MB）`,
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
          success: false,
          message: '错误：图片上传失败，未获取到 image_key',
        };
      }

      // 发送图片消息
      await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      console.error(`${logPrefix} 图片已发送: ${fileName}`);
      return {
        success: true,
        message: `图片 "${fileName}" 已发送给用户${description ? `，说明：${description}` : ''}`,
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
          success: false,
          message: '错误：音频上传失败，未获取到 file_key',
        };
      }

      // 发送音频消息
      await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'audio',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      console.error(`${logPrefix} 音频已发送: ${fileName}`);
      return {
        success: true,
        message: `音频 "${fileName}" 已发送给用户${description ? `，说明：${description}` : ''}`,
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
          success: false,
          message: '错误：文件上传失败，未获取到 file_key',
        };
      }

      // 发送文件消息
      await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      console.error(`${logPrefix} 文件已发送: ${fileName}`);
      return {
        success: true,
        message: `文件 "${fileName}" 已发送给用户${description ? `，说明：${description}` : ''}`,
      };
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`${logPrefix} 文件发送失败: ${errMsg}`);
    return {
      success: false,
      message: `错误：文件发送失败 - ${errMsg}`,
    };
  }
}
