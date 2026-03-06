import dotenv from 'dotenv';
dotenv.config({ override: true });

export type FeishuOutputMode = 'card' | 'reply';
export type FeishuReplyFormat = 'text' | 'md';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false;
  return defaultValue;
}

function parseFeishuOutputMode(value: string | undefined): FeishuOutputMode {
  if (!value) return 'reply';
  const normalized = value.trim().toLowerCase();
  return normalized === 'card' ? 'card' : 'reply';
}

function parseFeishuReplyFormat(value: string | undefined): FeishuReplyFormat {
  if (!value) return 'md';
  const normalized = value.trim().toLowerCase();
  return normalized === 'text' ? 'text' : 'md';
}

export const config = {
  // AI Provider: 'claude' | 'codex'
  aiProvider: (process.env.AI_PROVIDER || 'claude') as 'claude' | 'codex',

  // Claude API（SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL）
  // Codex API（SDK 自动读取 OPENAI_API_KEY 或 CODEX_API_KEY）

  // 飞书
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',

  // 启动通知（可选，填 open_id 或 chat_id）
  notifyUserId: process.env.NOTIFY_USER_ID || '',

  // 开发者目录特例（可选，命中后优先使用本机目录）
  developerOpenId: process.env.DEVELOPER_OPEN_ID || '',
  developerWorkspace: process.env.DEVELOPER_WORKSPACE || (process.env.HOME || ''),

  // 飞书输出模式：card（单卡片更新）| reply（按消息回复）
  feishuOutputMode: parseFeishuOutputMode(process.env.FEISHU_OUTPUT_MODE),

  // reply 消息格式：md（默认，post 富文本 md 节点）| text（纯文本）
  feishuReplyFormat: parseFeishuReplyFormat(process.env.FEISHU_REPLY_FORMAT),

  // reply 模式展示控制
  feishuReplyShowToolCalls: parseBoolean(process.env.FEISHU_REPLY_SHOW_TOOL_CALLS, true),
  feishuReplyShowToolInput: parseBoolean(process.env.FEISHU_REPLY_SHOW_TOOL_INPUT, true),
  feishuReplyShowToolResult: parseBoolean(process.env.FEISHU_REPLY_SHOW_TOOL_RESULT, true),
  feishuReplyShowUsage: parseBoolean(process.env.FEISHU_REPLY_SHOW_USAGE, true),
  feishuReplyShowQueueNotice: parseBoolean(process.env.FEISHU_REPLY_SHOW_QUEUE_NOTICE, true),

  // reply 模式接收确认（给用户消息添加 reaction）
  feishuReplyAckReaction: parseBoolean(process.env.FEISHU_REPLY_ACK_REACTION, true),
  feishuReplyAckEmoji: process.env.FEISHU_REPLY_ACK_EMOJI || 'OK',

  // 工作目录
  workspace: process.env.WORKSPACE || '/workspace',
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
