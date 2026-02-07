import dotenv from 'dotenv';
dotenv.config({ override: true });

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
