import fs from 'fs';
import path from 'path';
import { AgentsConfig, AgentConfig } from './types.js';

export function loadAgentsConfig(): AgentsConfig {
  const configPath = path.resolve(process.cwd(), 'agents.json');

  if (!fs.existsSync(configPath)) {
    console.error('❌ 未找到 agents.json 配置文件');
    console.error('请参考 agents.example.json 创建配置文件');
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as AgentsConfig;

    validateConfig(config);

    return config;
  } catch (error) {
    console.error('❌ 配置文件解析失败:', error);
    process.exit(1);
  }
}

function validateConfig(config: AgentsConfig): void {
  if (!config.agents || !Array.isArray(config.agents)) {
    throw new Error('配置文件格式错误: agents 必须是数组');
  }

  if (config.agents.length === 0) {
    throw new Error('配置文件中没有 Agent');
  }

  const ids = new Set<string>();
  const appIds = new Set<string>();

  for (const agent of config.agents) {
    validateAgent(agent);

    // 检查 ID 唯一性
    if (ids.has(agent.id)) {
      throw new Error(`Agent ID 重复: ${agent.id}`);
    }
    ids.add(agent.id);

    // 检查飞书 APP_ID 唯一性
    if (appIds.has(agent.feishu.appId)) {
      throw new Error(`飞书 APP_ID 重复: ${agent.feishu.appId}`);
    }
    appIds.add(agent.feishu.appId);

    // 检查工作目录是否存在
    if (!fs.existsSync(agent.workspace)) {
      throw new Error(`Agent [${agent.name}] 的工作目录不存在: ${agent.workspace}`);
    }
  }
}

function validateAgent(agent: AgentConfig): void {
  if (!agent.id || typeof agent.id !== 'string') {
    throw new Error('Agent 缺少 id 字段');
  }

  if (!agent.name || typeof agent.name !== 'string') {
    throw new Error(`Agent [${agent.id}] 缺少 name 字段`);
  }

  if (!agent.provider || !['claude', 'codex'].includes(agent.provider)) {
    throw new Error(`Agent [${agent.name}] 的 provider 必须是 claude 或 codex`);
  }

  if (!agent.workspace || typeof agent.workspace !== 'string') {
    throw new Error(`Agent [${agent.name}] 缺少 workspace 字段`);
  }

  if (agent.notifyUserId !== undefined && typeof agent.notifyUserId !== 'string') {
    throw new Error(`Agent [${agent.name}] 的 notifyUserId 必须是字符串`);
  }

  if (!agent.feishu || typeof agent.feishu !== 'object') {
    throw new Error(`Agent [${agent.name}] 缺少 feishu 配置`);
  }

  if (!agent.feishu.appId || typeof agent.feishu.appId !== 'string') {
    throw new Error(`Agent [${agent.name}] 缺少 feishu.appId`);
  }

  if (!agent.feishu.appSecret || typeof agent.feishu.appSecret !== 'string') {
    throw new Error(`Agent [${agent.name}] 缺少 feishu.appSecret`);
  }
}
