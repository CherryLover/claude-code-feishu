#!/usr/bin/env node

import dotenv from 'dotenv';
import * as Lark from '@larksuiteoapi/node-sdk';

dotenv.config({ override: true, quiet: true });

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const query = getArg('query');
const content = getArg('content');
const dryRun = process.argv.includes('--dry-run');

if (!query || !content) {
  console.error('用法: node scripts/test-send-feishu-message.mjs --query=蒋纪伟或手机号 --content=消息内容 [--dry-run]');
  process.exit(1);
}

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error('❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}

function formatError(error) {
  const status = error?.response?.status;
  const code = error?.response?.data?.code;
  const msg = error?.response?.data?.msg || error?.message || String(error);
  const logId = error?.response?.data?.error?.log_id;
  return `${status ? `HTTP ${status} - ` : ''}${msg}${code !== undefined ? ` (code: ${code})` : ''}${logId ? ` | log_id: ${logId}` : ''}`;
}

function pad2(num) {
  return String(num).padStart(2, '0');
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function formatIsoWithOffset(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offsetHour = pad2(Math.floor(absOffset / 60));
  const offsetMin = pad2(absOffset % 60);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMin}`;
}

function getTomorrowSchedule() {
  const now = new Date();
  const tomorrowBase = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const dueAt = new Date(
    tomorrowBase.getFullYear(),
    tomorrowBase.getMonth(),
    tomorrowBase.getDate(),
    18,
    0,
    0,
  );

  const eventStart = new Date(
    tomorrowBase.getFullYear(),
    tomorrowBase.getMonth(),
    tomorrowBase.getDate(),
    10,
    0,
    0,
  );

  const eventEnd = new Date(
    tomorrowBase.getFullYear(),
    tomorrowBase.getMonth(),
    tomorrowBase.getDate(),
    11,
    0,
    0,
  );

  return {
    date: formatLocalDate(tomorrowBase),
    dueTimestampMs: dueAt.getTime(),
    eventStartIso: formatIsoWithOffset(eventStart),
    eventEndIso: formatIsoWithOffset(eventEnd),
  };
}

const larkLogger = {
  error: (...msg) => {
    const flatten = (input) => input.flatMap((x) => Array.isArray(x) ? flatten(x) : [x]);
    const arr = flatten(msg);
    const text = arr.map((x) => (typeof x === 'string' ? x : formatError(x))).join(' | ');
    console.error(`[LarkSDK] ${text}`);
  },
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

const client = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  loggerLevel: Lark.LoggerLevel.error,
  logger: larkLogger,
});

let cachedPrimaryCalendarId = null;

async function getUserDetail(openId) {
  try {
    const resp = await client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: { user_id_type: 'open_id' },
    });
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

async function searchByPhoneOrEmail(keyword) {
  const trimmed = keyword.trim();
  const isEmail = trimmed.includes('@');
  const digits = trimmed.replace(/[\s-]/g, '');
  const isPhone = /^(\+?\d{7,15})$/.test(digits);
  if (!isEmail && !isPhone) return [];

  const mobileCandidates = isPhone
    ? Array.from(new Set([
        digits,
        digits.startsWith('+') ? digits : `+${digits}`,
        digits.startsWith('86') ? `+${digits}` : `+86${digits}`,
      ]))
    : [];

  const reqBody = isEmail
    ? { emails: [trimmed] }
    : { mobiles: mobileCandidates };

  const resp = await client.request({
    method: 'POST',
    url: '/open-apis/contact/v3/users/batch_get_id',
    params: { user_id_type: 'open_id' },
    data: reqBody,
  });

  const list = resp?.data?.user_list || [];
  const openIds = list
    .map((item) => item?.user_id)
    .filter(Boolean);

  const users = [];
  for (const openId of openIds) {
    const detail = await getUserDetail(openId);
    if (detail) users.push(detail);
  }
  return users;
}

async function searchByName(keyword) {
  const q = keyword.trim().toLowerCase();
  if (!q) return [];

  const users = [];
  let pageToken;
  do {
    const resp = await client.request({
      method: 'GET',
      url: '/open-apis/contact/v3/users/find_by_department',
      params: {
        department_id: '0',
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const items = resp?.data?.items || [];
    for (const item of items) {
      const name = (item?.name || '').toLowerCase();
      const enName = (item?.en_name || '').toLowerCase();
      if (name.includes(q) || enName.includes(q)) {
        users.push({
          open_id: item.open_id,
          name: item.name,
          email: item.email,
          mobile: item.mobile,
        });
      }
    }

    pageToken = resp?.data?.page_token;
    if (users.length >= 10) break;
  } while (pageToken);

  return users;
}

async function searchUser(keyword) {
  const preciseUsers = await searchByPhoneOrEmail(keyword);
  if (preciseUsers.length > 0) return preciseUsers;
  return await searchByName(keyword);
}

async function sendMessage(openId, text) {
  const resp = await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  return resp?.data?.message_id || null;
}

async function createTodo(openId, title, description, dueTimestampMs) {
  const resp = await client.request({
    method: 'POST',
    url: '/open-apis/task/v2/tasks',
    params: { user_id_type: 'open_id' },
    data: {
      summary: title,
      description,
      members: [
        {
          id: openId,
          type: 'user',
          role: 'assignee',
        },
      ],
      due: {
        timestamp: String(dueTimestampMs),
        is_all_day: false,
      },
    },
  });

  return resp?.data?.task?.guid || null;
}

async function getPrimaryCalendarId() {
  if (cachedPrimaryCalendarId) return cachedPrimaryCalendarId;

  const resp = await client.request({
    method: 'GET',
    url: '/open-apis/calendar/v4/calendars',
    params: { type: 'primary' },
  });

  const calendarId = resp?.data?.calendar_list?.[0]?.calendar_id;

  if (!calendarId) {
    throw new Error('获取主日历 ID 失败');
  }

  cachedPrimaryCalendarId = calendarId;
  return calendarId;
}

async function createCalendarEvent(openId, title, description, startIso, endIso) {
  const calendarId = await getPrimaryCalendarId();
  const startTimestamp = Math.floor(new Date(startIso).getTime() / 1000);
  const endTimestamp = Math.floor(new Date(endIso).getTime() / 1000);

  if (Number.isNaN(startTimestamp) || Number.isNaN(endTimestamp)) {
    throw new Error(`日程时间格式无效: start=${startIso}, end=${endIso}`);
  }

  const eventResp = await client.request({
    method: 'POST',
    url: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
    params: { user_id_type: 'open_id' },
    data: {
      summary: title,
      description,
      start_time: { timestamp: String(startTimestamp) },
      end_time: { timestamp: String(endTimestamp) },
    },
  });

  const eventId = eventResp?.data?.event?.event_id;
  if (!eventId) {
    throw new Error('创建日程成功但未返回 event_id');
  }

  await client.request({
    method: 'POST',
    url: `/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`,
    params: { user_id_type: 'open_id' },
    data: {
      attendees: [
        {
          type: 'user',
          user_id: openId,
        },
      ],
    },
  });

  return eventId;
}

async function main() {
  console.log(`\n[测试] query=${query}`);
  const users = await searchUser(query);

  if (users.length === 0) {
    console.log('[结果] 未找到匹配用户');
    process.exit(2);
  }

  const target = users[0];
  console.log(`[结果] 命中用户: ${target.name} | ${target.open_id} | ${target.mobile || ''} | ${target.email || ''}`);

  const tomorrow = getTomorrowSchedule();
  console.log(`[时间] 明天日期=${tomorrow.date} | 日程=${tomorrow.eventStartIso} ~ ${tomorrow.eventEndIso}`);

  if (dryRun) {
    console.log('[dry-run] 跳过发送，仅验证查人成功');
    return;
  }

  const messageId = await sendMessage(target.open_id, content);
  console.log(`[发送成功] message_id=${messageId}`);

  const todoTitle = `【测试】请在明天处理文件问题`;
  const todoDesc = `自动测试创建，执行时间：${new Date().toLocaleString()}`;
  const taskGuid = await createTodo(target.open_id, todoTitle, todoDesc, tomorrow.dueTimestampMs);
  console.log(`[待办成功] task_guid=${taskGuid}`);

  const eventTitle = `【测试】文件问题沟通`;
  const eventDesc = `自动测试创建，明天沟通文件问题。`;
  const eventId = await createCalendarEvent(
    target.open_id,
    eventTitle,
    eventDesc,
    tomorrow.eventStartIso,
    tomorrow.eventEndIso,
  );
  console.log(`[日程成功] event_id=${eventId}`);
}

main().catch((error) => {
  const text = formatError(error);
  console.error(`[失败] ${text}`);
  if (error?.response?.data?.code === 230013) {
    console.error('[提示] 目标用户不在当前机器人可用范围（availability）中。请在飞书后台将该用户加入应用可用范围。');
  }
  process.exit(1);
});
