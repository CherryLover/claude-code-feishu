import './core/bot-env.js';
import os from 'os';
import path from 'path';

export type FeishuReplyFormat = 'text' | 'md';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false;
  return defaultValue;
}

function parseFeishuReplyFormat(value: string | undefined): FeishuReplyFormat {
  if (!value) return 'md';
  const normalized = value.trim().toLowerCase();
  return normalized === 'text' ? 'text' : 'md';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

function resolvePath(value: string | undefined, defaultValue: string): string {
  if (!value) return defaultValue;
  return path.resolve(value);
}

function resolveDefaultSchedulerDbPath(): string {
  const namespace = process.env.BOT_RUNTIME_NAMESPACE?.trim();
  if (!namespace) {
    return path.resolve(process.cwd(), 'data', 'scheduler.sqlite');
  }

  const safeNamespace = namespace.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
  return path.resolve(process.cwd(), 'data', `scheduler-${safeNamespace}.sqlite`);
}

export const config = {
  // AI Provider: 'claude' | 'codex'（getter 确保 Worker 中 applyProviderEnvOverrides 后能读到最新值）
  get aiProvider() { return (process.env.AI_PROVIDER || 'claude') as 'claude' | 'codex'; },

  // Claude API（SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL）
  // Codex API（SDK 自动读取 OPENAI_API_KEY 或 CODEX_API_KEY）

  // 飞书
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',

  // 启动通知（可选，填 open_id 或 chat_id）
  notifyUserId: process.env.NOTIFY_USER_ID || '',

  // 单用户访问限制（按用户名匹配）
  authorizedUserName: process.env.AUTHORIZED_USER_NAME || '',

  // 单用户消息工作目录（默认当前系统用户目录，兼容旧的 DEVELOPER_WORKSPACE）
  messageWorkspace: resolvePath(process.env.MESSAGE_WORKSPACE || process.env.DEVELOPER_WORKSPACE, os.homedir()),

  // 最终 reply 消息格式：md（默认，post 富文本 md 节点）| text（纯文本）
  feishuReplyFormat: parseFeishuReplyFormat(process.env.FEISHU_REPLY_FORMAT),

  // 最终 reply 是否展示 Token/费用信息
  feishuReplyShowUsage: parseBoolean(process.env.FEISHU_REPLY_SHOW_USAGE, true),

  // 收到消息后给用户消息添加 reaction
  feishuReplyAckReaction: parseBoolean(process.env.FEISHU_REPLY_ACK_REACTION, true),
  feishuReplyAckEmoji: process.env.FEISHU_REPLY_ACK_EMOJI || 'OK',

  // 工作目录
  workspace: process.env.WORKSPACE || '/workspace',

  // 定时任务（SQLite + 单实例调度）
  schedulerEnabled: parseBoolean(process.env.SCHEDULER_ENABLED, false),
  schedulerDbPath: resolvePath(process.env.SCHEDULER_DB_PATH, resolveDefaultSchedulerDbPath()),
  schedulerTaskTimeoutMs: parseNumber(process.env.SCHEDULER_TASK_TIMEOUT_MS, 10 * 60 * 1000),
};

export function validateConfig() {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    console.error('缺少飞书配置: FEISHU_APP_ID, FEISHU_APP_SECRET');
    process.exit(1);
  }

  if (config.aiProvider === 'codex') {
    if (!process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
      console.error('缺少 Codex API 配置: OPENAI_API_KEY 或 CODEX_API_KEY');
      process.exit(1);
    }
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('缺少 Claude API 配置: ANTHROPIC_API_KEY');
      process.exit(1);
    }
  }
}
