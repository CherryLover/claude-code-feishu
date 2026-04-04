# 飞书多 Agent 管理系统 - 简化方案（MVP）

## 目标

用最简单的方式实现多 Agent 支持：
- 通过 JSON 配置文件管理 Agent
- 每个 Agent 独立的飞书机器人和工作目录
- 启动时自动加载配置并启动所有 Agent
- 如果没有配置文件，程序退出

## 配置文件格式

### 文件位置
`agents.json`（项目根目录）

### 配置结构
```json
{
  "agents": [
    {
      "id": "project-a",
      "name": "项目 A",
      "description": "前端项目 AI 助手",
      "provider": "codex",
      "workspace": "/workspace/project-a",
      "feishu": {
        "appId": "cli_xxx1",
        "appSecret": "xxx1"
      }
    },
    {
      "id": "project-b",
      "name": "项目 B",
      "description": "后端项目 AI 助手",
      "provider": "claude",
      "workspace": "/workspace/project-b",
      "feishu": {
        "appId": "cli_xxx2",
        "appSecret": "xxx2"
      }
    }
  ]
}
```

### 字段说明
- `id`: Agent 唯一标识（必填）
- `name`: Agent 名称（必填）
- `description`: Agent 描述（可选）
- `provider`: AI 提供商，`claude` 或 `codex`（必填）
- `workspace`: 工作目录绝对路径（必填）
- `feishu.appId`: 飞书 APP_ID（必填）
- `feishu.appSecret`: 飞书 APP_SECRET（必填）

## 实施步骤

### 1. 创建配置类型定义（src/agents/types.ts）
```typescript
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  provider: 'claude' | 'codex';
  workspace: string;
  feishu: {
    appId: string;
    appSecret: string;
  };
}

export interface AgentsConfig {
  agents: AgentConfig[];
}
```

### 2. 创建配置加载器（src/agents/loader.ts）
```typescript
import fs from 'fs';
import path from 'path';

export function loadAgentsConfig(): AgentsConfig {
  const configPath = path.resolve(process.cwd(), 'agents.json');
  
  if (!fs.existsSync(configPath)) {
    console.error('未找到 agents.json 配置文件');
    process.exit(1);
  }
  
  const content = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(content);
  
  // 基础校验
  validateConfig(config);
  
  return config;
}
```

### 3. 重构 FeishuClient 为类（src/feishu/client.ts）
```typescript
export class FeishuClient {
  constructor(
    private agentId: string,
    private agentName: string,
    private appId: string,
    private appSecret: string,
    private workspace: string,
    private provider: 'claude' | 'codex'
  ) {}
  
  async connect(): Promise<void> {
    // 建立 WebSocket 连接
  }
  
  async disconnect(): Promise<void> {
    // 断开连接
  }
}
```

### 4. 创建 AgentInstance（src/agents/instance.ts）
```typescript
export class AgentInstance {
  private feishuClient: FeishuClient;
  
  constructor(private config: AgentConfig) {}
  
  async start(): Promise<void> {
    // 创建 FeishuClient
    // 连接飞书
  }
  
  async stop(): Promise<void> {
    // 断开连接
  }
}
```

### 5. 修改入口文件（src/index.ts）
```typescript
import { loadAgentsConfig } from './agents/loader.js';
import { AgentInstance } from './agents/instance.js';

const config = loadAgentsConfig();
const instances: AgentInstance[] = [];

console.log(`加载了 ${config.agents.length} 个 Agent 配置`);

for (const agentConfig of config.agents) {
  const instance = new AgentInstance(agentConfig);
  await instance.start();
  instances.push(instance);
  console.log(`✓ Agent [${agentConfig.name}] 已启动`);
}

// 优雅关闭
process.on('SIGINT', async () => {
  for (const instance of instances) {
    await instance.stop();
  }
  process.exit(0);
});
```

## 改造重点

### 需要改动的文件
1. `src/feishu/client.ts` - 改为类，接收 Agent 配置
2. `src/providers/index.ts` - 支持传入 workspace 参数
3. `src/core/task-executor.ts` - 支持传入 workspace 参数
4. `src/index.ts` - 改为读取配置并启动多个实例

### 不需要改动的文件
- `src/providers/claude.ts` - Provider 逻辑不变
- `src/providers/codex.ts` - Provider 逻辑不变
- `src/feishu/messages.ts` - 消息发送逻辑不变
- `src/feishu/formatter.ts` - 格式化逻辑不变
- `src/core/task-progress.ts` - 进度管理不变

## 关键改造点

### 1. FeishuClient 实例化
**原来（全局单例）：**
```typescript
export function startFeishuBot() {
  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });
  // ...
}
```

**改为（实例化）：**
```typescript
export class FeishuClient {
  private client: Lark.Client;
  
  constructor(config: AgentConfig) {
    this.client = new Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
  }
}
```

### 2. Workspace 传递
**原来（全局配置）：**
```typescript
const workspace = config.messageWorkspace;
```

**改为（实例配置）：**
```typescript
const workspace = this.config.workspace;
```

### 3. Provider 初始化
**原来（全局）：**
```typescript
const provider = getProvider(config.aiProvider);
```

**改为（实例）：**
```typescript
const provider = getProvider(this.config.provider, this.config.workspace);
```

## 测试步骤

1. 创建 `agents.json` 配置文件
2. 配置 2 个 Agent（不同飞书机器人、不同工作目录）
3. 启动程序：`npm run dev`
4. 分别在两个飞书机器人中发送消息
5. 验证：
   - 两个 Agent 都能正常响应
   - 工作目录隔离（Agent A 在目录 A 工作，Agent B 在目录 B 工作）
   - 会话隔离（互不干扰）

## 后续扩展

完成简化版后，可以逐步添加：
- 数据库存储（替代 JSON 文件）
- Web 管理界面
- Token 统计
- 配置热更新
- 更多功能...

参考完整方案：`MULTI_AGENT_PLAN_FULL.md`
