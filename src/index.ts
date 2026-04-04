import { loadAgentsConfig } from './agents/loader.js';
import { AgentInstance } from './agents/instance.js';

console.log('🤖 飞书多 Agent 管理系统启动中...\n');

let shuttingDown = false;
let exitCode = 0;

// 加载配置
const config = loadAgentsConfig();
console.log(`📋 加载了 ${config.agents.length} 个 Agent 配置\n`);

// 创建 Agent 实例
const instances: AgentInstance[] = config.agents.map((agentConfig) => new AgentInstance(agentConfig, {
  onUnexpectedExit: ({ agent, code }) => {
    console.error(`❌ Agent [${agent.name}] 意外退出，系统将停止 (code=${code})`);
    exitCode = code || 1;
    shutdown(exitCode).catch((error) => {
      console.error('异常退出后的关闭失败:', error);
      process.exit(exitCode || 1);
    });
  },
}));

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = Math.max(exitCode, code);

  console.log('\n🛑 正在关闭所有 Agent...');

  for (const instance of instances) {
    try {
      await instance.stop();
    } catch (error) {
      console.error(`关闭 Agent 失败:`, error);
    }
  }

  console.log('👋 再见！');
  process.exit(exitCode);
}

// 启动所有 Agent
for (const instance of instances) {
  try {
    await instance.start();
  } catch (error) {
    console.error(`❌ Agent [${instance.getConfig().name}] 启动失败:`, error);
    exitCode = 1;
    await shutdown(exitCode);
  }
}

if (shuttingDown) {
  process.exit(exitCode || 1);
}

console.log(`\n✨ 所有 Agent 已启动完成！\n`);

process.on('SIGINT', () => {
  shutdown(exitCode).catch((error) => {
    console.error('关闭失败:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown(exitCode).catch((error) => {
    console.error('关闭失败:', error);
    process.exit(1);
  });
});
