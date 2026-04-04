import { Worker } from 'worker_threads';
import { AgentConfig } from './types.js';

const isTsMode = import.meta.url.endsWith('.ts');

function createTsWorkerBootstrap(workerModuleUrl: URL): string {
  return `
(async () => {
  const { register } = await import('tsx/esm/api');
  register();
  await import(${JSON.stringify(workerModuleUrl.href)});
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

export interface AgentUnexpectedExitInfo {
  agent: AgentConfig;
  code: number;
}

interface AgentInstanceOptions {
  onUnexpectedExit?: (info: AgentUnexpectedExitInfo) => void;
}

export class AgentInstance {
  private config: AgentConfig;
  private worker: Worker | null = null;
  private started = false;
  private stopping = false;
  private readonly onUnexpectedExit?: (info: AgentUnexpectedExitInfo) => void;

  constructor(config: AgentConfig, options: AgentInstanceOptions = {}) {
    this.config = config;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  async start(): Promise<void> {
    if (this.started) {
      console.warn(`Agent [${this.config.name}] 已经启动`);
      return;
    }

    console.log(`🚀 启动 Agent [${this.config.name}]`);
    console.log(`   - ID: ${this.config.id}`);
    console.log(`   - Provider: ${this.config.provider}`);
    console.log(`   - Workspace: ${this.config.workspace}`);
    console.log(`   - 飞书 APP_ID: ${this.config.feishu.appId}`);

    return new Promise((resolve, reject) => {
      const workerData = {
        provider: this.config.provider,
        agentConfig: this.config,
      };

      this.stopping = false;

      this.worker = isTsMode
        ? new Worker(
            createTsWorkerBootstrap(new URL('../core/bot-worker.ts', import.meta.url)),
            {
              eval: true,
              workerData,
            },
          )
        : new Worker(new URL('../core/bot-worker.js', import.meta.url), { workerData });

      let settled = false;

      this.worker.on('online', () => {
        if (settled) return;
        settled = true;
        this.started = true;
        console.log(`✅ Agent [${this.config.name}] 启动成功\n`);
        resolve();
      });

      this.worker.on('error', (error) => {
        if (settled) {
          console.error(`❌ Agent [${this.config.name}] 运行异常:`, error);
          return;
        }
        settled = true;
        console.error(`❌ Agent [${this.config.name}] 异常:`, error);
        reject(error);
      });

      this.worker.on('exit', (code) => {
        const expectedStop = this.stopping;
        this.started = false;
        this.worker = null;

        if (!settled) {
          settled = true;
          reject(new Error(`Agent [${this.config.name}] 启动失败，worker 提前退出 (code=${code})`));
          return;
        }

        if (expectedStop || code === 0) {
          console.log(`Agent [${this.config.name}] 已停止`);
          return;
        }

        console.error(`❌ Agent [${this.config.name}] 异常退出 (code=${code})`);
        if (this.onUnexpectedExit) {
          this.onUnexpectedExit({
            agent: this.config,
            code,
          });
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    console.log(`🛑 停止 Agent [${this.config.name}]`);
    this.stopping = true;
    try {
      await this.worker.terminate();
    } finally {
      this.worker = null;
      this.started = false;
      this.stopping = false;
    }
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  isStarted(): boolean {
    return this.started;
  }
}
