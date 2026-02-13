/**
 * 飞书 REST API 封装 — 供 Claude MCP 和 Codex MCP 共享
 *
 * 纯业务逻辑，不涉及 MCP 协议。
 * 包含：搜索用户、发送消息、创建任务、创建日程。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { ActionResult } from './feishu-actions.js';

// --- 类型定义 ---

export interface FeishuUser {
  open_id: string;
  name: string;
  email?: string;
  mobile?: string;
  department_name?: string;
}

export interface CreateTaskParams {
  title: string;
  assignee_open_id: string;
  due_date?: string;       // ISO 8601 日期，如 2025-01-20
  description?: string;
}

export interface CreateCalendarEventParams {
  title: string;
  start_time: string;      // ISO 8601，如 2025-01-20T15:00:00+08:00
  end_time?: string;        // 默认 start_time + 1 小时
  attendee_open_ids: string[];
  description?: string;
  need_meeting?: boolean;   // 默认 true
}

// --- 缓存 ---

let primaryCalendarId: string | null = null;

// --- 错误处理 ---

interface FeishuApiErrorInfo {
  message: string;
  status?: number;
  code?: number;
  msg?: string;
  logId?: string;
}

function parseFeishuApiError(error: unknown): FeishuApiErrorInfo {
  const err = error as any;
  const status = typeof err?.response?.status === 'number' ? err.response.status : undefined;
  const code = typeof err?.response?.data?.code === 'number' ? err.response.data.code : undefined;
  const msg = typeof err?.response?.data?.msg === 'string' ? err.response.data.msg : undefined;
  const logId = typeof err?.response?.data?.error?.log_id === 'string'
    ? err.response.data.error.log_id
    : undefined;

  const fallback = error instanceof Error ? error.message : '未知错误';
  const core = msg ? `${msg}${code !== undefined ? ` (code: ${code})` : ''}` : fallback;
  const message = `${status ? `HTTP ${status} - ` : ''}${core}${logId ? ` | log_id: ${logId}` : ''}`;

  return { message, status, code, msg, logId };
}

function isNoDeptAuthorityError(info: FeishuApiErrorInfo): boolean {
  return info.code === 40004 || (info.msg || '').toLowerCase().includes('no dept authority');
}

function buildNoDeptAuthorityMessage(query: string): string {
  return `无法按姓名搜索「${query}」：当前飞书应用缺少通讯录部门可见范围权限（code: 40004 no dept authority）。请在飞书开放平台为应用配置通讯录权限范围，或改用邮箱/手机号搜索。`;
}

// --- 搜索用户 ---

/**
 * 在组织通讯录中搜索用户
 *
 * 策略：
 * - 如果 query 像邮箱或手机号，用 batch_get_id 精确查找
 * - 否则按部门遍历（从根部门开始），按姓名过滤
 */
export async function searchUser(
  client: Lark.Client,
  query: string,
  logPrefix = '[飞书API]'
): Promise<{ success: boolean; users: FeishuUser[]; message: string }> {
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return { success: false, users: [], message: '搜索关键词不能为空' };
    }

    // 判断是否为邮箱或手机号
    const isEmail = trimmed.includes('@');
    const isPhone = /^(\+?\d{7,15})$/.test(trimmed.replace(/[\s-]/g, ''));

    if (isEmail || isPhone) {
      return await searchByEmailOrMobile(client, trimmed, isEmail, logPrefix);
    }

    // 按部门遍历，姓名模糊匹配
    return await searchByDepartment(client, trimmed, logPrefix);
  } catch (error: unknown) {
    const errInfo = parseFeishuApiError(error);
    console.error(`${logPrefix} 搜索用户失败: ${errInfo.message}`);
    return { success: false, users: [], message: `搜索用户失败: ${errInfo.message}` };
  }
}

async function searchByEmailOrMobile(
  client: Lark.Client,
  query: string,
  isEmail: boolean,
  logPrefix: string
): Promise<{ success: boolean; users: FeishuUser[]; message: string }> {
  const body: any = {};
  if (isEmail) {
    body.emails = [query];
  } else {
    body.mobiles = [query.replace(/[\s-]/g, '')];
  }

  const resp = await client.request({
    method: 'POST',
    url: '/open-apis/contact/v3/users/batch_get_id',
    params: { user_id_type: 'open_id' },
    data: body,
  }) as any;

  const userList = resp?.data?.user_list || [];
  if (userList.length === 0) {
    return { success: true, users: [], message: `未找到匹配「${query}」的用户` };
  }

  // 获取用户详细信息
  const users: FeishuUser[] = [];
  for (const item of userList) {
    if (!item.user_id) continue;
    const detail = await getUserDetail(client, item.user_id);
    if (detail) users.push(detail);
  }

  if (users.length === 0) {
    return { success: true, users: [], message: `未找到匹配「${query}」的用户` };
  }

  console.error(`${logPrefix} 精确查找到 ${users.length} 个用户`);
  return {
    success: true,
    users,
    message: `找到 ${users.length} 个用户`,
  };
}

async function searchByDepartment(
  client: Lark.Client,
  query: string,
  logPrefix: string
): Promise<{ success: boolean; users: FeishuUser[]; message: string }> {
  const matchedUsers: FeishuUser[] = [];
  const queryLower = query.toLowerCase();

  // 先获取子部门列表，如果失败则只搜索根部门
  let departmentIds: string[];
  try {
    departmentIds = await getAllDepartmentIds(client);
  } catch (err) {
    const errInfo = parseFeishuApiError(err);
    if (isNoDeptAuthorityError(errInfo)) {
      const message = buildNoDeptAuthorityMessage(query);
      console.error(`${logPrefix} ${message}`);
      return { success: false, users: [], message };
    }
    console.error(`${logPrefix} 获取部门列表失败，仅搜索根部门: ${errInfo.message}`);
    departmentIds = ['0'];
  }

  for (const deptId of departmentIds) {
    let pageToken: string | undefined;
    do {
      try {
        const resp = await client.request({
          method: 'GET',
          url: '/open-apis/contact/v3/users/find_by_department',
          params: {
            department_id: deptId,
            user_id_type: 'open_id',
            department_id_type: 'open_department_id',
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }) as any;

        const items = resp?.data?.items || [];
        for (const user of items) {
          const name = user.name || '';
          const enName = user.en_name || '';
          if (
            name.toLowerCase().includes(queryLower) ||
            enName.toLowerCase().includes(queryLower)
          ) {
            matchedUsers.push({
              open_id: user.open_id,
              name: user.name,
              email: user.email,
              mobile: user.mobile,
            });
          }
        }

        pageToken = resp?.data?.page_token;
      } catch (err) {
        const errInfo = parseFeishuApiError(err);
        if (isNoDeptAuthorityError(errInfo)) {
          const message = buildNoDeptAuthorityMessage(query);
          console.error(`${logPrefix} ${message}`);
          return { success: false, users: [], message };
        }
        console.error(`${logPrefix} 查询部门 ${deptId} 用户失败: ${errInfo.message}`);
        pageToken = undefined;
      }
      // 找到足够多结果就提前退出
      if (matchedUsers.length >= 10) break;
    } while (pageToken);

    if (matchedUsers.length >= 10) break;
  }

  console.error(`${logPrefix} 按姓名搜索到 ${matchedUsers.length} 个用户`);
  return {
    success: true,
    users: matchedUsers,
    message: matchedUsers.length > 0
      ? `找到 ${matchedUsers.length} 个匹配「${query}」的用户`
      : `未找到匹配「${query}」的用户`,
  };
}

async function getAllDepartmentIds(client: Lark.Client): Promise<string[]> {
  const departmentIds: string[] = ['0']; // 根部门
  const queue: string[] = ['0'];

  // BFS 遍历子部门
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    let pageToken: string | undefined;

    do {
      const resp = await client.request({
        method: 'GET',
        url: `/open-apis/contact/v3/departments/${parentId}/children`,
        params: {
          department_id_type: 'open_department_id',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }) as any;

      const items = resp?.data?.items || [];
      for (const dept of items) {
        if (dept.open_department_id) {
          departmentIds.push(dept.open_department_id);
          queue.push(dept.open_department_id);
        }
      }
      pageToken = resp?.data?.page_token;
    } while (pageToken);

    // 安全上限，避免组织架构特别大时无限遍历
    if (departmentIds.length >= 200) break;
  }

  return departmentIds;
}

async function getUserDetail(
  client: Lark.Client,
  openId: string,
): Promise<FeishuUser | null> {
  try {
    const resp = await client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: { user_id_type: 'open_id' },
    }) as any;

    const user = resp?.data?.user;
    if (!user) return null;

    return {
      open_id: user.open_id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
    };
  } catch {
    return null;
  }
}

// --- 发送私聊消息 ---

/**
 * 给指定用户发送飞书私聊消息
 */
export async function sendMessageToUser(
  client: Lark.Client,
  openId: string,
  content: string,
  logPrefix = '[飞书API]'
): Promise<ActionResult> {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    });

    console.error(`${logPrefix} 消息已发送给 ${openId}`);
    return {
      success: true,
      message: `消息已成功发送给用户 (${openId})`,
    };
  } catch (error: unknown) {
    const errInfo = parseFeishuApiError(error);
    const errText = errInfo.message;
    console.error(`${logPrefix} 发送消息失败: ${errText}`);

    // 常见错误：用户未与机器人建立对话
    if (
      errText.includes('bot_not_in_chat')
      || errText.includes('not in bot')
      || (errInfo.msg || '').includes('bot_not_in_chat')
    ) {
      return {
        success: false,
        message: '发送失败：用户未与机器人建立对话，需要用户先打开机器人聊天窗口',
      };
    }

    return {
      success: false,
      message: `发送消息失败: ${errText}`,
    };
  }
}

// --- 创建待办任务 ---

/**
 * 创建飞书待办任务并指派给用户
 */
export async function createTask(
  client: Lark.Client,
  params: CreateTaskParams,
  logPrefix = '[飞书API]'
): Promise<ActionResult> {
  try {
    const taskData: any = {
      summary: params.title,
      members: [
        {
          id: params.assignee_open_id,
          type: 'user',
          role: 'assignee',
        },
      ],
    };

    if (params.description) {
      taskData.description = params.description;
    }

    if (params.due_date) {
      const dueTimestamp = new Date(params.due_date).getTime();
      if (!isNaN(dueTimestamp)) {
        taskData.due = {
          timestamp: String(dueTimestamp),
          is_all_day: !params.due_date.includes('T'),
        };
      }
    }

    const resp = await client.request({
      method: 'POST',
      url: '/open-apis/task/v2/tasks',
      params: { user_id_type: 'open_id' },
      data: taskData,
    }) as any;

    const taskGuid = resp?.data?.task?.guid;
    console.error(`${logPrefix} 任务已创建: ${taskGuid}`);

    return {
      success: true,
      message: `待办任务「${params.title}」已创建并指派${params.due_date ? `，截止日期: ${params.due_date}` : ''}`,
    };
  } catch (error: unknown) {
    const errInfo = parseFeishuApiError(error);
    console.error(`${logPrefix} 创建任务失败: ${errInfo.message}`);
    return {
      success: false,
      message: `创建任务失败: ${errInfo.message}`,
    };
  }
}

// --- 创建日程 ---

/**
 * 创建飞书日程并邀请参与者
 */
export async function createCalendarEvent(
  client: Lark.Client,
  params: CreateCalendarEventParams,
  logPrefix = '[飞书API]'
): Promise<ActionResult> {
  try {
    // 获取主日历 ID
    const calendarId = await getPrimaryCalendarId(client, logPrefix);
    if (!calendarId) {
      return {
        success: false,
        message: '无法获取机器人的主日历，请确认日历权限已配置',
      };
    }

    const startTimestamp = Math.floor(new Date(params.start_time).getTime() / 1000);
    if (isNaN(startTimestamp)) {
      return {
        success: false,
        message: `无效的开始时间格式: ${params.start_time}`,
      };
    }

    let endTimestamp: number;
    if (params.end_time) {
      endTimestamp = Math.floor(new Date(params.end_time).getTime() / 1000);
      if (isNaN(endTimestamp)) {
        return {
          success: false,
          message: `无效的结束时间格式: ${params.end_time}`,
        };
      }
    } else {
      endTimestamp = startTimestamp + 3600; // 默认 1 小时
    }

    const eventData: any = {
      summary: params.title,
      start_time: { timestamp: String(startTimestamp) },
      end_time: { timestamp: String(endTimestamp) },
    };

    if (params.description) {
      eventData.description = params.description;
    }

    // 视频会议（默认开启）
    if (params.need_meeting !== false) {
      eventData.vchat = { vc_type: 'vc' };
    }

    const resp = await client.request({
      method: 'POST',
      url: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
      params: { user_id_type: 'open_id' },
      data: eventData,
    }) as any;

    const eventId = resp?.data?.event?.event_id;

    // 添加参与者
    if (params.attendee_open_ids.length > 0 && eventId) {
      const attendees = params.attendee_open_ids.map((id) => ({
        type: 'user',
        user_id: id,
      }));

      await client.request({
        method: 'POST',
        url: `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`,
        params: { user_id_type: 'open_id' },
        data: { attendees },
      });
    }

    console.error(`${logPrefix} 日程已创建: ${eventId}`);

    const meetingInfo = params.need_meeting !== false ? '（含视频会议）' : '';
    return {
      success: true,
      message: `日程「${params.title}」已创建${meetingInfo}，已邀请 ${params.attendee_open_ids.length} 位参与者`,
    };
  } catch (error: unknown) {
    const errInfo = parseFeishuApiError(error);
    console.error(`${logPrefix} 创建日程失败: ${errInfo.message}`);
    return {
      success: false,
      message: `创建日程失败: ${errInfo.message}`,
    };
  }
}

async function getPrimaryCalendarId(
  client: Lark.Client,
  logPrefix: string
): Promise<string | null> {
  if (primaryCalendarId) return primaryCalendarId;

  try {
    const resp = await client.request({
      method: 'GET',
      url: '/open-apis/calendar/v4/calendars',
      params: { type: 'primary' },
    }) as any;

    const calendarId = resp?.data?.calendar_list?.[0]?.calendar_id;
    if (calendarId) {
      primaryCalendarId = calendarId;
      console.error(`${logPrefix} 获取主日历 ID: ${calendarId}`);
    }
    return calendarId || null;
  } catch (error: unknown) {
    const errInfo = parseFeishuApiError(error);
    console.error(`${logPrefix} 获取主日历失败: ${errInfo.message}`);
    return null;
  }
}
