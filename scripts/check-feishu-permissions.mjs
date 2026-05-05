#!/usr/bin/env node

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

dotenv.config({ override: true, quiet: true });

const args = process.argv.slice(2);
const runSendTest = args.includes('--send-test');
const checkAll = args.includes('--all');
const agentIdFlagIndex = args.indexOf('--agent');
const targetAgentId = agentIdFlagIndex >= 0 ? args[agentIdFlagIndex + 1] : null;

// 项目实际依赖的飞书配置清单（用于输出"复制即可"的引导清单）
const REQUIRED_CONFIG = {
  permissions: [
    { scope: 'im:message', desc: '消息基础权限' },
    { scope: 'im:message:send_as_bot', desc: '以机器人身份发送消息' },
    { scope: 'im:message.p2p_msg:readonly', desc: '接收私聊消息' },
    { scope: 'im:message.group_at_msg:readonly', desc: '接收群聊中 @机器人 的消息' },
    { scope: 'im:resource', desc: '上传图片和文件 (im.image.create / im.file.create)' },
    { scope: 'im:chat:readonly', desc: '读取群信息（话题群 / 两人群识别）' },
    { scope: 'contact:user.id:readonly', desc: '通过邮箱/手机精确查用户 ID' },
    { scope: 'contact:user.base:readonly', desc: '获取用户基本信息（姓名等）' },
    { scope: 'contact:department.base:readonly', desc: '部门遍历（按姓名模糊搜索的兜底逻辑依赖）' },
    { scope: 'calendar:calendar', desc: '创建日程 / 邀请参与者' },
    { scope: 'task:task', desc: '创建飞书待办（schedule_* 工具依赖）' },
  ],
  events: [
    { name: 'im.message.receive_v1', desc: '接收用户消息' },
    { name: 'application.bot.menu_v6', desc: '自定义菜单点击回调（/clear /stop /status）' },
    { name: 'card.action.trigger', desc: '卡片按钮回调（"复制原文"按钮）' },
  ],
  menu: [
    { event_key: '/clear', name: '清除会话', desc: '清空当前会话上下文，开始新对话' },
    { event_key: '/stop', name: '停止处理', desc: '中断当前正在跑的任务' },
    { event_key: '/status', name: '查询状态', desc: '查看是否有活跃会话' },
  ],
};

function loadAgentTargets() {
  const agentsJsonPath = path.resolve(process.cwd(), 'agents.json');
  if (!fs.existsSync(agentsJsonPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(agentsJsonPath, 'utf-8'));
    if (!Array.isArray(parsed?.agents) || parsed.agents.length === 0) return null;
    return parsed.agents.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      appId: a.feishu?.appId,
      appSecret: a.feishu?.appSecret,
      notifyUserId: a.notifyUserId || '',
    })).filter((a) => a.appId && a.appSecret);
  } catch (err) {
    console.error(`❌ 解析 agents.json 失败: ${err.message}`);
    process.exit(1);
  }
}

function resolveTargets() {
  const fromAgents = loadAgentTargets();
  if (targetAgentId) {
    if (!fromAgents) {
      console.error('❌ --agent 需要 agents.json 存在');
      process.exit(1);
    }
    const found = fromAgents.find((a) => a.id === targetAgentId);
    if (!found) {
      console.error(`❌ agents.json 中找不到 id="${targetAgentId}"，可用：${fromAgents.map((a) => a.id).join(', ')}`);
      process.exit(1);
    }
    return [found];
  }
  if (checkAll && fromAgents) return fromAgents;

  const envAppId = process.env.FEISHU_APP_ID;
  const envAppSecret = process.env.FEISHU_APP_SECRET;
  if (!envAppId || !envAppSecret) {
    if (fromAgents) {
      console.error('❌ 当前未提供 FEISHU_APP_ID/SECRET 环境变量。可用方式：');
      console.error('   - npm run check:feishu-perms -- --all              # 检查 agents.json 中所有 Agent');
      console.error('   - npm run check:feishu-perms -- --agent <agent-id> # 检查指定 Agent');
      console.error(`   可用 Agent: ${fromAgents.map((a) => a.id).join(', ')}`);
    } else {
      console.error('❌ 缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET');
    }
    process.exit(1);
  }
  return [{
    id: 'env',
    name: '当前 .env',
    appId: envAppId,
    appSecret: envAppSecret,
    notifyUserId: process.env.NOTIFY_USER_ID || '',
  }];
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

function buildClient(appId, appSecret) {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    loggerLevel: Lark.LoggerLevel.error,
    logger: larkLogger,
  });
}

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

async function checkTarget(target) {
  const { appId, appSecret, notifyUserId } = target;
  const client = buildClient(appId, appSecret);
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

  if (!notifyUserId || !notifyUserId.startsWith('oc_')) {
    results.push({
      name: '群信息读取（两人群直连 / 话题群识别）',
      endpoint: 'GET /open-apis/im/v1/chats/:chat_id',
      permission: '群详情读取能力',
      status: 'skip',
      detail: '未配置 chat_id 格式的 NOTIFY_USER_ID，跳过群信息读取测试',
    });
  } else {
    results.push(await runCheck(
      '群信息读取（两人群直连 / 话题群识别）',
      'GET /open-apis/im/v1/chats/:chat_id',
      '群详情读取能力',
      async () => {
        await client.im.chat.get({
          params: { user_id_type: 'open_id' },
          path: { chat_id: notifyUserId },
        });
      },
    ));
  }

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

  console.log(`\n=== 飞书权限探针: ${target.name} (app_id=${appId}) ===\n`);

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

  printConfigChecklist(target, failCount > 0);

  return { passCount, failCount, skipCount };
}

function printConfigChecklist(target, hasFailures) {
  const { appId } = target;
  const adminUrl = `https://open.feishu.cn/app/${appId}/dev_config`;

  if (hasFailures) {
    console.log('\n⚠️ 检测到能力缺失。下面是项目所需的完整飞书配置清单，可对照后台逐项核对：');
  } else {
    console.log('\n✅ 必要权限均已通过黑盒探针。下面附上完整配置清单，方便你核对事件订阅 / 自定义菜单（这两类无法通过 API 自动检测）：');
  }

  console.log('\n📋 必备 API 权限（飞书后台 → 权限管理 → 开通权限，搜索框逐个粘贴）：\n');
  for (const p of REQUIRED_CONFIG.permissions) {
    console.log(`   ${p.scope.padEnd(40)} # ${p.desc}`);
  }
  console.log('\n   纯权限名（直接复制下面整段）：\n');
  console.log('   ' + REQUIRED_CONFIG.permissions.map((p) => p.scope).join('\n   '));

  console.log('\n📡 必备事件订阅（飞书后台 → 事件与回调 → 事件订阅）：\n');
  for (const e of REQUIRED_CONFIG.events) {
    console.log(`   ${e.name.padEnd(34)} # ${e.desc}`);
  }
  console.log('\n   ⚠️ 飞书未开放事件订阅查询 API，无法自动检测，请手动到后台核对上述事件已勾选。');

  console.log('\n🍔 必备自定义菜单（飞书后台 → 机器人 → 自定义菜单）：\n');
  console.log('   名称           event_key   说明');
  console.log('   ─────────────  ──────────  ────────────────────────────');
  for (const m of REQUIRED_CONFIG.menu) {
    console.log(`   ${m.name.padEnd(13)}  ${m.event_key.padEnd(10)}  ${m.desc}`);
  }
  console.log('\n   ⚠️ 飞书未开放菜单配置 API，无法自动检测。请手动添加上述三个菜单项。');

  console.log(`\n🔗 直达后台：${adminUrl}\n`);
}

async function main() {
  const targets = resolveTargets();
  console.log(`将检查 ${targets.length} 个机器人配置：${targets.map((t) => t.name).join(', ')}`);

  const summary = [];
  for (const target of targets) {
    try {
      const r = await checkTarget(target);
      summary.push({ target, ...r });
    } catch (error) {
      const info = parseError(error);
      console.error(`\n❌ [${target.name}] 探针执行失败: ${info.detail}`);
      summary.push({ target, passCount: 0, failCount: -1, skipCount: 0, error: info.detail });
    }
  }

  if (targets.length > 1) {
    console.log('\n=== 多 Agent 汇总 ===');
    for (const s of summary) {
      const status = s.error ? '⚠️ 异常' : s.failCount > 0 ? '❌ 有缺失' : '✅ 通过';
      console.log(`${status}  ${s.target.name.padEnd(20)} 通过 ${s.passCount} / 失败 ${Math.max(0, s.failCount)} / 跳过 ${s.skipCount}`);
    }
  }

  if (summary.some((s) => s.error || s.failCount > 0)) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const info = parseError(error);
  console.error(`\n❌ 权限探针执行失败: ${info.detail}`);
  process.exit(1);
});
