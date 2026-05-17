import { threadId, workerData } from 'worker_threads';
import { applyProviderEnvOverrides } from './bot-env.js';
import type { AgentConfig } from '../agents/types.js';
import { loadCredentialsConfig, resolveCredential, applyCredentialEnv } from '../agents/credentials.js';

interface WorkerLaunchData {
  agentConfig?: AgentConfig;
}

const launchData = workerData as WorkerLaunchData | undefined;
const agentConfig = launchData?.agentConfig;
if (!agentConfig) {
  throw new Error('缺少 worker agentConfig 配置');
}

// 解析该 Agent 引用的凭证，引擎(claude/codex)由凭证决定。
const credential = resolveCredential(agentConfig.credential, loadCredentialsConfig());

// 先应用非 AI 的通用环境覆盖（飞书/工作目录等），再注入凭证。
applyProviderEnvOverrides(credential.engine, {
  runtimeNamespace: agentConfig.id,
});

// AI 凭证完全由 credentials.json 决定，落到本 Worker 的 env 供 SDK 读取。
applyCredentialEnv(credential);

// Agent 专属配置覆盖。
process.env.FEISHU_APP_ID = agentConfig.feishu.appId;
process.env.FEISHU_APP_SECRET = agentConfig.feishu.appSecret;
process.env.MESSAGE_WORKSPACE = agentConfig.workspace;
process.env.WORKSPACE = agentConfig.workspace;
// 多 Agent 模式下不默认继承 provider 级 NOTIFY_USER_ID，避免把通知发到错误会话。
process.env.NOTIFY_USER_ID = agentConfig.notifyUserId || '';
process.env.BOT_RUNTIME_NAMESPACE = agentConfig.id;
process.env.INSTANCE_TAG = `${agentConfig.id}:${threadId}`;

const runnerModule = import.meta.url.endsWith('.ts') ? './bot-runner.ts' : './bot-runner.js';
const { runBot } = await import(runnerModule);
runBot();
