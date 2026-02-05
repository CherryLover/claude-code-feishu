import 'dotenv/config';
import { config, validateConfig } from './config';
import { startFeishuBot } from './feishu';

validateConfig();

console.log('Claude Code Feishu Bot 启动中...');
console.log(`工作目录: ${config.workspace}`);
console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? '已配置' : '未配置'}`);
console.log(`API URL: ${process.env.ANTHROPIC_BASE_URL || '默认'}`);

startFeishuBot();
