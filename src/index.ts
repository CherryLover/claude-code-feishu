import 'dotenv/config';
import { config, validateConfig } from './config';
import { startFeishuBot } from './feishu';

validateConfig();

console.log('AI Code Feishu Bot 启动中...');
console.log(`AI Provider: ${config.aiProvider}`);
console.log(`工作目录: ${config.workspace}`);
if (config.aiProvider === 'codex') {
  console.log(`API Key: ${(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) ? '已配置' : '未配置'}`);
  console.log(`API URL: ${process.env.OPENAI_BASE_URL || '默认'}`);
} else {
  console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? '已配置' : '未配置'}`);
  console.log(`API URL: ${process.env.ANTHROPIC_BASE_URL || '默认'}`);
}

startFeishuBot();
