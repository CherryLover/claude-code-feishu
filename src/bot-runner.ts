import { config, validateConfig } from './config.js';
import { startFeishuBot } from './feishu.js';

export function runBot(): void {
  validateConfig();

  console.log('AI Code Feishu Bot 启动中...');
  console.log(`AI Provider: ${config.aiProvider}`);
  console.log(`允许用户: ${config.authorizedUserName || '未限制'}`);
  console.log(`消息工作目录: ${config.messageWorkspace}`);
  console.log(`Provider 备用工作目录: ${config.workspace}`);
  console.log(`定时任务: ${config.schedulerEnabled ? `启用 (${config.schedulerDbPath})` : '未启用'}`);
  if (config.aiProvider === 'codex') {
    console.log(`API Key: ${(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) ? '已配置' : '未配置'}`);
    console.log(`API URL: ${process.env.OPENAI_BASE_URL || '默认'}`);
  } else {
    console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? '已配置' : '未配置'}`);
    console.log(`API URL: ${process.env.ANTHROPIC_BASE_URL || '默认'}`);
  }

  startFeishuBot();
}
