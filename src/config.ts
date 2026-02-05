export const config = {
  // Claude API（SDK 自动读取 ANTHROPIC_API_KEY 和 ANTHROPIC_BASE_URL）

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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('缺少 Claude API 配置: ANTHROPIC_API_KEY');
    process.exit(1);
  }
}
