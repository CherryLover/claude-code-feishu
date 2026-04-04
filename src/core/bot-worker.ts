import { threadId, workerData } from 'worker_threads';
import { applyProviderEnvOverrides, type AiProvider } from './bot-env.js';
import type { AgentConfig } from '../agents/types.js';

interface WorkerLaunchData {
  provider?: AiProvider;
  agentConfig?: AgentConfig;
}

const launchData = workerData as WorkerLaunchData | undefined;
const agentConfig = launchData?.agentConfig;
const provider = agentConfig?.provider || launchData?.provider;
if (!provider) {
  throw new Error('缺少 worker provider 配置');
}

// 先应用 provider 级覆盖，兼容 CLAUDE_*/CODEX_* 环境变量。
applyProviderEnvOverrides(provider, {
  runtimeNamespace: agentConfig?.id || provider,
});

// 如果有 agentConfig，再覆盖 Agent 专属配置。
if (agentConfig) {
  process.env.AI_PROVIDER = agentConfig.provider;
  process.env.FEISHU_APP_ID = agentConfig.feishu.appId;
  process.env.FEISHU_APP_SECRET = agentConfig.feishu.appSecret;
  process.env.MESSAGE_WORKSPACE = agentConfig.workspace;
  process.env.WORKSPACE = agentConfig.workspace;
  process.env.BOT_RUNTIME_NAMESPACE = agentConfig.id;
  process.env.INSTANCE_TAG = `${agentConfig.id}:${threadId}`;
} else {
  if (!process.env.INSTANCE_TAG || process.env.INSTANCE_TAG === provider) {
    process.env.INSTANCE_TAG = `${provider}:${threadId}`;
  }
}

const runnerModule = import.meta.url.endsWith('.ts') ? './bot-runner.ts' : './bot-runner.js';
const { runBot } = await import(runnerModule);
runBot();
