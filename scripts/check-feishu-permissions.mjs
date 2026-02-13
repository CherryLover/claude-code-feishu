#!/usr/bin/env node

import dotenv from 'dotenv';
import * as Lark from '@larksuiteoapi/node-sdk';

dotenv.config({ override: true, quiet: true });

const runSendTest = process.argv.includes('--send-test');

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const notifyUserId = process.env.NOTIFY_USER_ID;

if (!appId || !appSecret) {
  console.error('❌ 缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET');
  process.exit(1);
}

function formatLarkLog(args) {
  const normalizedArgs = args.flatMap((item) => (Array.isArray(item) ? item : [item]));

  return normalizedArgs
    .map((item) => {
      if (typeof item === 'string') return item;
      const status = item?.response?.status;
      const code = item?.response?.data?.code;
      const msg = item?.response?.data?.msg || item?.message;
      const logId = item?.response?.data?.error?.log_id;
      if (status || code || msg) {
        return `${status ? `HTTP ${status} - ` : ''}${msg || '飞书请求失败'}${code !== undefined ? ` (code: ${code})` : ''}${logId ? ` | log_id: ${logId}` : ''}`;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(' | ');
}

const larkLogger = {
  error: (...msg) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  warn: (...msg) => console.warn(`[LarkSDK] ${formatLarkLog(msg)}`),
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

function parseError(error) {
  const httpStatus = typeof error?.response?.status === 'number' ? error.response.status : undefined;
  const code = typeof error?.response?.data?.code === 'number' ? error.response.data.code : undefined;
  const msg = typeof error?.response?.data?.msg === 'string' ? error.response.data.msg : undefined;
  const logId = typeof error?.response?.data?.error?.log_id === 'string'
    ? error.response.data.error.log_id
    : undefined;
  const fallback = error instanceof Error ? error.message : String(error);
  return {
    httpStatus,
    code,
    msg,
    logId,
    detail: `${httpStatus ? `HTTP ${httpStatus} - ` : ''}${msg || fallback}${code !== undefined ? ` (code: ${code})` : ''}${logId ? ` | log_id: ${logId}` : ''}`,
  };
}

async function runCheck(name, endpoint, permission, fn) {
  try {
    await fn();
    return { name, endpoint, permission, status: 'pass' };
  } catch (error) {
    const info = parseError(error);
    return {
      name,
      endpoint,
      permission,
      status: 'fail',
      ...info,
    };
  }
}

async function main() {
  const results = [];
  let scopeInfo = null;
  let scopeError = null;

  results.push(await runCheck(
    '机器人信息读取',
    'GET /open-apis/bot/v3/info/',
    '机器人基础权限',
    async () => {
      await client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' });
    },
  ));

  results.push(await runCheck(
    '通讯录精确查人（邮箱/手机号）',
    'POST /open-apis/contact/v3/users/batch_get_id',
    '通讯录用户 ID 查询权限',
    async () => {
      await client.request({
        method: 'POST',
        url: '/open-apis/contact/v3/users/batch_get_id',
        params: { user_id_type: 'open_id' },
        data: { mobiles: ['13800000000'] },
      });
    },
  ));

  results.push(await runCheck(
    '通讯录部门读取',
    'GET /open-apis/contact/v3/departments/0/children',
    '通讯录部门读取 + 可见范围',
    async () => {
      await client.request({
        method: 'GET',
        url: '/open-apis/contact/v3/departments/0/children',
        params: { department_id_type: 'open_department_id', page_size: 1 },
      });
    },
  ));

  results.push(await runCheck(
    '通讯录按部门查人（姓名模糊搜索依赖）',
    'GET /open-apis/contact/v3/users/find_by_department',
    '通讯录用户读取 + 可见范围',
    async () => {
      await client.request({
        method: 'GET',
        url: '/open-apis/contact/v3/users/find_by_department',
        params: {
          department_id: '0',
          department_id_type: 'open_department_id',
          user_id_type: 'open_id',
          page_size: 1,
        },
      });
    },
  ));

  results.push(await runCheck(
    '日历主日历读取',
    'GET /open-apis/calendar/v4/calendars?type=primary',
    '日历读取权限（用于 create_calendar_event）',
    async () => {
      await client.request({
        method: 'GET',
        url: '/open-apis/calendar/v4/calendars',
        params: { type: 'primary' },
      });
    },
  ));

  try {
    const scopeResp = await client.request({
      method: 'GET',
      url: '/open-apis/contact/v3/scopes',
      params: {
        user_id_type: 'open_id',
        department_id_type: 'open_department_id',
        page_size: 100,
      },
    });
    const data = scopeResp?.data || {};
    const userIds = Array.isArray(data.user_ids) ? data.user_ids : [];
    const departmentIds = Array.isArray(data.department_ids) ? data.department_ids : [];
    scopeInfo = {
      userCount: userIds.length,
      departmentCount: departmentIds.length,
      hasMore: Boolean(data.has_more),
      sampleUsers: userIds.slice(0, 3),
      sampleDepartments: departmentIds.slice(0, 3),
    };
  } catch (error) {
    scopeError = parseError(error);
  }

  if (runSendTest) {
    if (!notifyUserId) {
      results.push({
        name: '发送消息权限验证（send_as_bot）',
        endpoint: 'POST /open-apis/im/v1/messages',
        permission: 'im:message:send_as_bot',
        status: 'skip',
        detail: '未配置 NOTIFY_USER_ID，跳过发送测试',
      });
    } else {
      results.push(await runCheck(
        '发送消息权限验证（send_as_bot）',
        'POST /open-apis/im/v1/messages',
        'im:message:send_as_bot',
        async () => {
          const receiveIdType = notifyUserId.startsWith('oc_') ? 'chat_id' : 'open_id';
          await client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: notifyUserId,
              msg_type: 'text',
              content: JSON.stringify({ text: '【权限探针】send_as_bot 发送能力验证，可忽略' }),
            },
          });
        },
      ));
    }
  }

  console.log('\n=== 飞书权限探针结果 ===\n');

  for (const result of results) {
    const icon = result.status === 'pass' ? '✅' : result.status === 'skip' ? '⏭️' : '❌';
    console.log(`${icon} ${result.name}`);
    console.log(`   接口: ${result.endpoint}`);
    console.log(`   期望权限: ${result.permission}`);
    if (result.status === 'pass') {
      console.log('   结果: 通过');
    } else {
      console.log(`   结果: ${result.detail || '失败'}`);
    }
    console.log('');
  }

  const passCount = results.filter((result) => result.status === 'pass').length;
  const failCount = results.filter((result) => result.status === 'fail').length;
  const skipCount = results.filter((result) => result.status === 'skip').length;

  console.log(`汇总: 通过 ${passCount} | 失败 ${failCount} | 跳过 ${skipCount}`);

  if (scopeInfo) {
    console.log('\n📌 通讯录范围概览');
    console.log(`   user_ids: ${scopeInfo.userCount}`);
    console.log(`   department_ids: ${scopeInfo.departmentCount}`);
    if (scopeInfo.sampleUsers.length > 0) {
      console.log(`   样例用户: ${scopeInfo.sampleUsers.join(', ')}`);
    }
    if (scopeInfo.sampleDepartments.length > 0) {
      console.log(`   样例部门: ${scopeInfo.sampleDepartments.join(', ')}`);
    }
    if (scopeInfo.departmentCount === 0 && scopeInfo.userCount <= 1) {
      console.log('   ⚠️ 当前范围极小：通常会导致按姓名/部门搜索失败（40004 no dept authority）');
      console.log('   建议在飞书开放平台把应用可用范围扩到目标部门或全员。');
    }
  } else if (scopeError) {
    console.log('\n📌 通讯录范围概览读取失败');
    console.log(`   ${scopeError.detail}`);
  }

  const hasNoDeptAuthority = results.some((result) => result.code === 40004);
  if (hasNoDeptAuthority) {
    console.log('\n⚠️ 检测到 no dept authority (40004)');
    console.log('建议：在飞书开放平台为当前应用补齐通讯录权限，并在权限范围中包含目标部门/成员。');
    console.log('否则 search_user 的姓名模糊搜索会持续失败。');
  }

  if (failCount > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const info = parseError(error);
  console.error(`\n❌ 权限探针执行失败: ${info.detail}`);
  process.exit(1);
});
