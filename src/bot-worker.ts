import { threadId, workerData } from 'worker_threads';
import { applyProviderEnvOverrides, type AiProvider } from './bot-env.js';

const provider = workerData?.provider as AiProvider | undefined;
if (!provider) {
  throw new Error('缺少 worker provider 配置');
}

applyProviderEnvOverrides(provider, {
  runtimeNamespace: provider,
});

if (!process.env.INSTANCE_TAG || process.env.INSTANCE_TAG === provider) {
  process.env.INSTANCE_TAG = `${provider}:${threadId}`;
}

const runnerModule = import.meta.url.endsWith('.ts') ? './bot-runner.ts' : './bot-runner.js';
const { runBot } = await import(runnerModule);
runBot();
