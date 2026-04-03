/**
 * Claude Agent SDK MCP 工具层
 *
 * 这个文件专门处理 Claude Agent SDK 的 MCP 集成。
 * 底层业务逻辑调用 feishu-actions.ts / feishu-api.ts，保持 MCP 层独立。
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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

export function createFeishuToolsServer(
  client: Lark.Client,
  context: { chatId: string; workingDirectory?: string },
) {
  const chatId = context.chatId;
  const defaultWorkingDirectory = context.workingDirectory;

  return createSdkMcpServer({
    name: 'feishu-tools',
    version: '1.0.0',
    tools: [
      tool(
        'send_file_to_user',
        '发送本地文件给用户。支持图片（PNG/JPG/GIF等）、文档（PDF/DOC/XLS/PPT等）、音频（MP3/WAV等）。默认发送到当前聊天；如果需要发送给指定用户，可传 open_id。',
        {
          file_path: z.string().describe('文件的绝对路径'),
          chat_id: z.string().optional().describe('目标飞书聊天 ID（可选，默认当前聊天）'),
          open_id: z.string().optional().describe('目标用户 open_id（可选，传入时优先按私聊发送）'),
          message: z.string().optional().describe('附带的说明文字（可选）'),
        },
        async (args) => {
          const targetOpenId = args.open_id?.trim();
          const targetChatId = args.chat_id?.trim() || chatId;
          const receiveIdType: 'chat_id' | 'open_id' = targetOpenId ? 'open_id' : 'chat_id';
          const receiveId = targetOpenId || targetChatId;

          if (!receiveId) {
            return {
              content: [{ type: 'text', text: '错误：缺少接收方参数，请提供 open_id 或 chat_id。' }],
            };
          }

          const result = await sendFileToFeishu(
            client,
            receiveId,
            args.file_path,
            args.message,
            '[Claude工具]',
            receiveIdType,
          );

          return {
            content: [{ type: 'text', text: result.message }],
          };
        }
      ),

      tool(
        'search_user',
        '在组织通讯录中搜索用户。支持按姓名模糊搜索，或按邮箱、手机号精确查找。返回用户的 open_id、姓名等信息。发送消息、创建任务、创建日程前，必须先用此工具获取目标用户的 open_id。',
        {
          query: z.string().describe('搜索关键词：用户姓名、邮箱或手机号'),
        },
        async (args) => {
          const result = await searchUser(client, args.query, '[Claude工具]');
          let text: string;
          if (result.users.length > 0) {
            const userLines = result.users.map((u, i) =>
              `${i + 1}. ${u.name} (open_id: ${u.open_id})${u.email ? ` | 邮箱: ${u.email}` : ''}${u.mobile ? ` | 手机: ${u.mobile}` : ''}`
            );
            text = `${result.message}\n\n${userLines.join('\n')}`;
          } else {
            text = result.message;
          }
          return { content: [{ type: 'text', text }] };
        }
      ),

      tool(
        'send_message_to_user',
        '给指定用户发送飞书私聊消息。需要先通过 search_user 获取用户的 open_id。',
        {
          open_id: z.string().describe('目标用户的 open_id（通过 search_user 获取）'),
          content: z.string().describe('消息内容（纯文本）'),
        },
        async (args) => {
          const result = await sendMessageToUser(
            client,
            args.open_id,
            args.content,
            '[Claude工具]'
          );
          return { content: [{ type: 'text', text: result.message }] };
        }
      ),

      tool(
        'create_task',
        '创建飞书待办任务并指派给用户。需要先通过 search_user 获取用户的 open_id。',
        {
          title: z.string().describe('任务标题'),
          assignee_open_id: z.string().describe('执行者的 open_id'),
          due_date: z.string().optional().describe('截止日期，ISO 8601 格式，如 2025-01-20'),
          description: z.string().optional().describe('任务描述'),
        },
        async (args) => {
          const result = await createTask(
            client,
            {
              title: args.title,
              assignee_open_id: args.assignee_open_id,
              due_date: args.due_date,
              description: args.description,
            },
            '[Claude工具]'
          );
          return { content: [{ type: 'text', text: result.message }] };
        }
      ),

      tool(
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
            '[Claude工具]'
          );
          return { content: [{ type: 'text', text: result.message }] };
        }
      ),

      tool(
        'schedule_list',
        '查看当前所有定时任务。适用于用户询问“有哪些定时”“查看日报定时”“当前有哪些周期任务”。',
        {
          include_disabled: z.boolean().optional().describe('是否包含已停用任务，默认 true'),
        },
        async (args) => ({
          content: [{ type: 'text', text: listSchedulesAction(args.include_disabled !== false) }],
        })
      ),

      tool(
        'schedule_create',
        '创建新的定时任务。适用于每天/每周/周期性执行某件事，并把结果主动推送到飞书。未指定 target_id 时，默认发送到当前聊天；未指定 working_directory 时，默认使用当前会话工作目录。',
        {
          id: z.string().optional().describe('可选，任务 ID；不传则根据名称自动生成'),
          name: z.string().describe('任务名称，例如“日报推送”'),
          cron: z.string().describe('cron 表达式，例如“0 30 9 * * 1-5”表示工作日 9:30'),
          timezone: z.string().optional().describe('时区，默认 Asia/Shanghai'),
          prompt: z.string().describe('到点后真正执行的 AI 指令内容'),
          target_type: z.enum(['chat_id', 'open_id']).optional().describe('结果发送目标类型，默认 chat_id'),
          target_id: z.string().optional().describe('结果发送目标 ID；默认当前聊天 ID'),
          working_directory: z.string().optional().describe('执行目录；默认当前会话工作目录'),
        },
        async (args) => ({
          content: [{
            type: 'text',
            text: createScheduleAction(args, {
              defaultTargetType: 'chat_id',
              defaultTargetId: chatId,
              defaultWorkingDirectory,
              client,
            }),
          }],
        })
      ),

      tool(
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
          content: [{
            type: 'text',
            text: updateScheduleAction(args, {
              defaultTargetType: 'chat_id',
              defaultTargetId: chatId,
              defaultWorkingDirectory,
              client,
            }),
          }],
        })
      ),

      tool(
        'schedule_enable',
        '启用一个已停用的定时任务。',
        {
          id: z.string().describe('任务 ID'),
        },
        async (args) => ({
          content: [{ type: 'text', text: enableScheduleAction(args.id) }],
        })
      ),

      tool(
        'schedule_disable',
        '停用一个定时任务，但保留配置和历史记录。',
        {
          id: z.string().describe('任务 ID'),
        },
        async (args) => ({
          content: [{ type: 'text', text: disableScheduleAction(args.id) }],
        })
      ),

      tool(
        'schedule_delete',
        '删除一个定时任务。',
        {
          id: z.string().describe('任务 ID'),
        },
        async (args) => ({
          content: [{ type: 'text', text: deleteScheduleAction(args.id) }],
        })
      ),

      tool(
        'schedule_run_now',
        '立即执行一个已有定时任务，并把结果发送到它配置的飞书目标。',
        {
          id: z.string().describe('任务 ID'),
        },
        async (args) => ({
          content: [{ type: 'text', text: await runScheduleNowAction(args.id, { client }) }],
        })
      ),
    ],
  });
}
