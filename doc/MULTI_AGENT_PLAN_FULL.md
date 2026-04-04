# 飞书多 Agent 管理系统 - 改造计划

## 为什么要这么做？

### 当前痛点
1. **单一工作目录限制** - 所有用户共享同一个工作目录，无法隔离不同项目的文件和上下文
2. **单一机器人限制** - 只能配置一个飞书机器人，无法为不同团队或项目提供独立的 AI 助手
3. **配置不灵活** - 环境变量配置方式难以动态调整，每次修改都需要重启服务
4. **资源无法隔离** - 多个项目或团队使用同一个 AI 实例，无法独立管理和监控

### 核心目的
1. **多项目并行支持** - 让多个 AI Agent 在不同工作目录下同时工作，互不干扰
2. **团队级隔离** - 每个团队可以拥有独立的飞书机器人和工作空间
3. **灵活配置管理** - 通过 Web 界面动态管理 Agent，无需重启服务
4. **精细化监控** - 独立追踪每个 Agent 的使用情况、Token 消耗和会话状态
5. **提升可扩展性** - 为未来支持更多 AI Provider 和高级功能打下基础

### 实际应用场景
- **多项目开发团队** - 项目 A 的 Agent 在 `/workspace/project-a` 工作，项目 B 的 Agent 在 `/workspace/project-b` 工作
- **前后端分离** - 前端团队使用 Agent A（Codex），后端团队使用 Agent B（Claude）
- **开发/测试环境隔离** - 开发环境 Agent 和生产环境 Agent 使用不同的工作目录和配置
- **客户定制服务** - 为不同客户提供独立的 AI 助手实例

## 项目目标

将现有的单飞书机器人架构改造为支持多 Agent 管理的系统，每个 Agent 可以：
- 绑定独立的飞书机器人（APP_ID/SECRET）
- 配置独立的工作目录
- 选择 AI Provider（Claude 或 Codex）
- 支持命名、分组、标签管理
- 通过 Web 界面进行配置和监控

## 当前架构分析

### 现状
- 单进程支持多 Provider（claude/codex），通过 Worker 线程隔离
- 每个 Provider 共享同一套飞书配置（`FEISHU_APP_ID`/`FEISHU_APP_SECRET`）
- 所有消息使用统一工作目录（`MESSAGE_WORKSPACE`）
- 配置通过环境变量管理

### 核心模块
```
index.ts → bot-worker.ts → bot-runner.ts → feishu/client.ts
                                          ↓
                                    providers/index.ts
                                          ↓
                                    claude.ts / codex.ts
```

## 改造方案

### 1. 数据库设计

#### agents 表
```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,                    -- Agent 唯一标识
  name TEXT NOT NULL,                     -- Agent 名称
  group_name TEXT,                        -- 分组
  tags TEXT,                              -- JSON 数组标签
  feishu_app_id TEXT NOT NULL UNIQUE,     -- 飞书 APP_ID
  feishu_app_secret TEXT NOT NULL,        -- 飞书 APP_SECRET
  ai_provider TEXT NOT NULL,              -- 'claude' | 'codex'
  workspace TEXT NOT NULL,                -- 工作目录
  enabled BOOLEAN DEFAULT true,           -- 是否启用
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

#### agent_sessions 表
```sql
CREATE TABLE agent_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

#### agent_usage 表
```sql
CREATE TABLE agent_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

### 2. 新增模块结构

```
src/
├── agents/                          # 新增：Agent 管理模块
│   ├── db.ts                       # Agent 数据库操作
│   ├── manager.ts                  # AgentManager 核心
│   ├── instance.ts                 # AgentInstance 封装
│   ├── types.ts                    # Agent 类型定义
│   └── config-io.ts                # 导入导出 JSON
│
├── web/                            # 新增：Web 管理界面
│   ├── server.ts                   # Express 服务器
│   ├── api.ts                      # REST API 路由
│   └── public/                     # H5 静态文件
│       └── index.html
│
├── core/                           # 重构：支持多实例
│   ├── bot-instance.ts             # 单个 Bot 实例（原 bot-runner）
│   └── ...
│
└── feishu/                         # 重构：实例化
    ├── client.ts                   # FeishuClient 类
    └── ...
```

### 3. 核心类设计

#### AgentManager（src/agents/manager.ts）
```typescript
class AgentManager {
  private agents: Map<string, AgentInstance> = new Map();
  
  async loadAgents(): Promise<void>
  async startAgent(agentId: string): Promise<void>
  async stopAgent(agentId: string): Promise<void>
  async restartAgent(agentId: string): Promise<void>
  getAgentStatus(agentId: string): AgentStatus
}
```

#### AgentInstance（src/agents/instance.ts）
```typescript
class AgentInstance {
  private feishuClient: FeishuClient;
  private provider: ClaudeProvider | CodexProvider;
  private config: AgentConfig;
  
  async start(): Promise<void>
  async stop(): Promise<void>
  getStatus(): AgentStatus
  getUsage(): AgentUsage
}
```

#### FeishuClient 实例化（src/feishu/client.ts）
```typescript
class FeishuClient {
  constructor(
    private agentId: string,
    private appId: string,
    private appSecret: string,
    private workspace: string,
    private provider: 'claude' | 'codex'
  )
  
  async connect(): Promise<void>
  async disconnect(): Promise<void>
}
```

### 4. Web 管理 API

#### REST API 端点
```
# Agent CRUD
GET    /api/agents              # 列表
GET    /api/agents/:id          # 详情
POST   /api/agents              # 创建
PUT    /api/agents/:id          # 更新
DELETE /api/agents/:id          # 删除

# Agent 控制
POST   /api/agents/:id/start    # 启动
POST   /api/agents/:id/stop     # 停止
POST   /api/agents/:id/restart  # 重启

# Agent 状态
GET    /api/agents/:id/status   # 状态
GET    /api/agents/:id/usage    # Token 统计
GET    /api/agents/:id/sessions # 会话列表

# 配置导入导出
GET    /api/config/export       # 导出 JSON
POST   /api/config/import       # 导入 JSON

# 飞书连接测试
POST   /api/test/feishu         # 测试飞书凭证
```

### 5. 定时任务关联

#### 修改 schedules 表
```sql
ALTER TABLE schedules ADD COLUMN agent_id TEXT;
ALTER TABLE schedules ADD FOREIGN KEY (agent_id) REFERENCES agents(id);
```

#### 逻辑
- 定时任务绑定到第一个 Codex Agent
- 如果没有 Codex Agent，禁用定时任务功能

### 6. 配置迁移策略

#### 环境变量 → 数据库
首次启动时，如果数据库为空且存在环境变量配置，自动创建默认 Agent：

```typescript
if (agents.length === 0 && process.env.FEISHU_APP_ID) {
  await createDefaultAgent({
    id: 'default',
    name: '默认 Agent',
    feishuAppId: process.env.FEISHU_APP_ID,
    feishuAppSecret: process.env.FEISHU_APP_SECRET,
    aiProvider: process.env.AI_PROVIDER || 'claude',
    workspace: process.env.MESSAGE_WORKSPACE || os.homedir(),
  });
}
```

## 实施步骤

### Phase 1: 数据库与配置管理
- [x] 设计数据库表结构
- [ ] 实现 Agent 配置管理模块（CRUD）
- [ ] 实现配置导入导出（JSON）

### Phase 2: 核心重构
- [ ] 实现 AgentManager 核心（加载、启动、停止）
- [ ] 重构 FeishuClient 为实例化类
- [ ] 重构 Provider 调用支持多实例

### Phase 3: 监控与统计
- [ ] 实现 Token 统计和会话追踪
- [ ] 实现 Agent 状态监控

### Phase 4: Web 管理界面
- [ ] 实现 Web 管理 API
- [ ] 开发 H5 管理界面（列表、表单、详情）

### Phase 5: 集成与测试
- [ ] 定时任务关联到默认 Codex Agent
- [ ] 测试多 Agent 并发运行
- [ ] 测试配置热更新

## 关键设计原则

### 1. API Key 管理
- 所有 Agent 共用全局 `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`
- 启动时校验哪些 Provider 的 Key 已配置
- 创建 Agent 时只能选择已配置 Key 的 Provider

### 2. 工作目录管理
- 输入工作目录后必须检查路径是否存在
- 路径不存在时报错，不自动创建
- 删除 Agent 时不删除工作目录文件

### 3. 会话隔离
- 由 Claude/Codex SDK 自动处理
- 不同 Agent 的会话完全独立

### 4. Agent 生命周期
- 启动时加载所有 `enabled: true` 的 Agent
- 编辑配置后需在管理后台手动"重启"
- 重启 = 停止旧实例 + 启动新实例
- 重启后不恢复会话历史
- 删除 Agent 时只从内存和数据库删除

### 5. 并发与资源
- 不限制全局或 Agent 级别并发
- 不限制 Agent 数量

### 6. 管理界面功能
- 基础：增删改查、启用/禁用、重启
- 状态：在线/离线、是否工作中、Token 消耗
- 详情：会话历史数量、Token 统计（按时间/会话维度）
- 校验：编辑后测试飞书连接、工作目录校验

### 7. 权限控制
- 无鉴权，仅本地使用

### 8. Agent 元数据
- 命名：每个 Agent 有唯一名称
- 分组：支持分组（如 `dev`、`prod`、`team-a`）
- 标签：支持多标签（如 `urgent`、`backend`）

### 9. 配置导入导出
- 导出格式：JSON 文件
- 导入格式：JSON 文件
- 用途：备份、迁移、批量配置

## 技术栈

- **数据库**: SQLite（复用 better-sqlite3）
- **Web 框架**: Express
- **前端**: 原生 HTML + CSS + JavaScript（轻量级）
- **WebSocket**: 复用现有 @larksuiteoapi/node-sdk

## 风险与注意事项

1. **飞书 WebSocket 连接数限制**：需要测试多个 Agent 同时连接的稳定性
2. **内存占用**：每个 Agent 独立实例，需要监控内存使用
3. **配置热更新**：重启 Agent 时需要妥善处理正在进行的对话
4. **定时任务兼容**：确保定时任务只关联到 Codex Agent
5. **数据迁移**：首次启动时需要提示用户手动配置 Agent

## 后续优化方向

1. **权限控制**：添加简单的 Token 鉴权
2. **通知告警**：Agent 离线时通过飞书通知管理员
3. **审计日志**：记录配置变更历史
4. **性能监控**：Agent 级别的性能指标（响应时间、错误率）
5. **批量操作**：批量启动/停止 Agent
6. **配置模板**：快速复制 Agent 配置
