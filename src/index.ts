import { Worker } from 'worker_threads';
import { applyProviderEnvOverrides, parseAiProviders, type AiProvider } from './core/bot-env.js';

const isTsMode = import.meta.url.endsWith('.ts');
const workerModuleUrl = new URL(
  isTsMode ? './core/bot-worker.ts' : './core/bot-worker.js',
  import.meta.url,
);
const runnerModule = isTsMode ? './core/bot-runner.ts' : './core/bot-runner.js';

const providers = parseAiProviders(process.env.AI_PROVIDER);
const workers = new Map<AiProvider, Worker>();
let shuttingDown = false;
let exitCode = 0;

function createTsWorkerBootstrap(moduleUrl: URL): string {
  return `
(async () => {
  const { register } = await import('tsx/esm/api');
  register();
  await import(${JSON.stringify(moduleUrl.href)});
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

function startProviderWorker(provider: AiProvider): void {
  const worker = isTsMode
    ? new Worker(createTsWorkerBootstrap(workerModuleUrl), {
        eval: true,
        workerData: { provider },
      })
    : new Worker(workerModuleUrl, {
        workerData: { provider },
      });

  workers.set(provider, worker);

  worker.on('online', () => {
    console.log(`[Bootstrap] ${provider} worker 已启动`);
  });

  worker.on('error', (error) => {
    console.error(`[Bootstrap] ${provider} worker 异常:`, error);
    exitCode = 1;
  });

  worker.on('exit', (code) => {
    workers.delete(provider);
    console.log(`[Bootstrap] ${provider} worker 已退出 (code=${code})`);

    if (!shuttingDown && code !== 0) {
      exitCode = code || 1;
      shutdown().catch((error) => {
        console.error('[Bootstrap] 关闭 worker 失败:', error);
        process.exit(exitCode || 1);
      });
      return;
    }

    if (!shuttingDown && workers.size === 0) {
      process.exit(exitCode);
    }
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const aliveWorkers = Array.from(workers.values());
  await Promise.allSettled(aliveWorkers.map((worker) => worker.terminate()));
  process.exit(exitCode);
}

console.log('AI Code Feishu Bot 启动中...');
console.log(`AI Providers: ${providers.join(', ')}`);

if (providers.length === 1) {
  applyProviderEnvOverrides(providers[0]);
  const { runBot } = await import(runnerModule);
  runBot();
} else {
  for (const provider of providers) {
    startProviderWorker(provider);
  }

  process.on('SIGINT', () => {
    shutdown().catch((error) => {
      console.error('[Bootstrap] SIGINT 关闭失败:', error);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown().catch((error) => {
      console.error('[Bootstrap] SIGTERM 关闭失败:', error);
      process.exit(1);
    });
  });
}
