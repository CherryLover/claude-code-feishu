# Claude Code Feishu Bot 实现计划 (修订版)

## 项目概述

一个极简的飞书机器人，通过飞书 WebSocket 长连接接收消息，调用 Claude Agent SDK 处理请求，并将中间过程和结果以 Markdown 卡片形式返回给用户。

---

## 计划审查发现的问题

### 问题 1：飞书 3 秒超时限制 ⚠️ 严重

**问题**：飞书长连接要求消息处理必须在 3 秒内完成，否则触发超时重推。Claude 对话可能持续几十秒甚至几分钟。

**解决方案**：事件处理器立即返回，使用 `setImmediate()` 异步处理 Claude 调用。

### 问题 2：消息去重机制缺失 ⚠️ 中等

**问题**：飞书超时或网络问题时会重推消息，可能导致同一消息被处理多次。

**解决方案**：添加 `message_id` 去重机制，使用 Set 存储已处理的消息 ID。

### 问题 3：权限配置不完整 ⚠️ 中等

**原计划权限**：`im:message`、`im:message:send_as_bot`

**实际需要**：
- `im:message` - 获取消息
- `im:message.p2p_msg:readonly` - 接收单聊消息
- `im:message.group_at_msg:readonly` - 接收群聊 @消息
- `im:message:send_as_bot` - 发送消息

### 问题 4：群聊 @机器人 处理

**修正**：初版支持群聊 @机器人，使用 `is_mention` 和 `text_without_at_bot` 字段。

### 问题 5：工具执行结果未展示

**修正**：解析 `AssistantMessage` 中的 `tool_result` 块，展示工具执行结果。

### 问题 6：环境变量配置

**发现**：Claude Agent SDK 自动读取 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL`，无需手动传递。

### 问题 7：错误处理策略

**修正**：明确处理 `AbortError`、API 限流 (429)、超时等错误类型。

---

## 核心需求

1. **飞书 WebSocket 长连接**：使用飞书官方 SDK 的 WSClient，无需公网 IP
2. **Claude Agent SDK 集成**：调用 `@anthropic-ai/claude-agent-sdk` 进行对话
3. **自定义 API 配置**：支持 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL`（代理）
4. **中间过程展示**：展示工具调用输入和结果（Bash、文件操作、搜索等）
5. **会话管理**：支持 `/clear`、`/new` 清除上下文
6. **Docker 部署**：每个飞书应用一个容器，工作目录映射到宿主机

---

## 技术栈

| 组件 | 选型 | 版本 |
|------|------|------|
| 运行时 | Node.js | 20.x |
| 语言 | TypeScript | 5.x |
| Claude SDK | @anthropic-ai/claude-agent-sdk | latest |
| 飞书 SDK | @larksuiteoapi/node-sdk | >= 1.24.0 |
| 容器化 | Docker | - |

---

## 项目结构

```
claude-code-feishu/
├── src/
│   ├── index.ts              # 入口文件
│   ├── config.ts             # 配置管理
│   ├── claude.ts             # Claude SDK 封装 + 流式处理
│   ├── feishu.ts             # 飞书消息收发
│   ├── formatter.ts          # 消息格式化（Markdown 卡片）
│   ├── dedup.ts              # 消息去重
│   └── types.ts              # 类型定义
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── PLAN.md
└── README.md
```

---

## 核心流程

```
飞书消息到达
    │
    ▼
事件处理器 (3秒内返回)
    │
    ├─► 检查消息去重 (message_id)
    │
    ├─► 检查消息类型 (只处理文本)
    │
    ├─► 检查是否需要响应
    │       - 私聊：始终响应
    │       - 群聊：仅响应 @机器人 (is_mention)
    │
    └─► setImmediate() 异步处理
            │
            ▼
        解析命令 (/clear, /new, /status)
            │
            ▼
        调用 Claude Agent SDK (includePartialMessages: true)
            │
            ├─► stream_event: content_block_start (tool_use)
            │       → 记录工具名称
            │
            ├─► stream_event: content_block_delta (input_json_delta)
            │       → 累积工具输入 JSON
            │
            ├─► stream_event: content_block_stop
            │       → 解析完整工具输入，格式化展示
            │
            ├─► assistant: tool_result
            │       → 展示工具执行结果
            │
            ├─► stream_event: content_block_delta (text_delta)
            │       → 累积文本响应
            │
            └─► result
                    → 最终结果
                        │
                        ▼
                    格式化 Markdown
                        │
                        ▼
                    发送飞书卡片消息
```

---

## 实现步骤

### 阶段 1：项目初始化

1. 初始化 npm 项目
2. 安装依赖：
   ```bash
   npm install @anthropic-ai/claude-agent-sdk @larksuiteoapi/node-sdk
   npm install -D typescript tsx @types/node
   ```
3. 配置 TypeScript (`tsconfig.json`)
4. 创建 `.gitignore`

### 阶段 2：配置模块 (`config.ts`)

```typescript
export const config = {
  // Claude API (SDK 自动读取环境变量)
  // ANTHROPIC_API_KEY - 必需
  // ANTHROPIC_BASE_URL - 可选，代理地址

  // 飞书
  feishuAppId: process.env.FEISHU_APP_ID!,
  feishuAppSecret: process.env.FEISHU_APP_SECRET!,

  // 工作目录
  workspace: process.env.WORKSPACE || '/workspace',
};
```

### 阶段 3：类型定义 (`types.ts`)

```typescript
// Claude 事件类型
export interface ClaudeEvent {
  type: 'tool_start' | 'tool_end' | 'tool_result' | 'text' | 'result' | 'error';
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  content?: string;
  sessionId?: string;
}

// 会话状态
export interface Session {
  claudeSessionId: string | null;
  lastActivity: number;
}
```

### 阶段 4：消息去重 (`dedup.ts`)

```typescript
export class MessageDedup {
  private processed = new Set<string>();
  private readonly maxSize = 10000;
  private readonly ttlMs = 5 * 60 * 1000; // 5 分钟

  isDuplicate(messageId: string): boolean {
    if (this.processed.has(messageId)) {
      return true;
    }
    this.processed.add(messageId);
    // 定期清理
    if (this.processed.size > this.maxSize) {
      this.cleanup();
    }
    return false;
  }

  private cleanup() {
    // 简单策略：超过阈值时清空一半
    const entries = Array.from(this.processed);
    this.processed = new Set(entries.slice(entries.length / 2));
  }
}
```

### 阶段 5：Claude SDK 封装 (`claude.ts`)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config';
import { ClaudeEvent } from './types';

export async function* streamClaudeChat(
  prompt: string,
  sessionId: string | null
): AsyncGenerator<ClaudeEvent> {

  const options: any = {
    cwd: config.workspace,
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  let currentTool: string | null = null;
  let toolInput = '';
  let newSessionId: string | null = null;

  try {
    for await (const message of query({ prompt, options })) {

      // 系统初始化消息 - 获取 session_id
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // 流式事件
      if (message.type === 'stream_event') {
        const event = message.event;

        // 工具开始
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentTool = event.content_block.name;
            toolInput = '';
            yield { type: 'tool_start', toolName: currentTool };
          }
        }

        // 工具输入增量
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'input_json_delta') {
            toolInput += event.delta.partial_json || '';
          }
          if (event.delta?.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text };
          }
        }

        // 工具结束
        if (event.type === 'content_block_stop' && currentTool) {
          yield { type: 'tool_end', toolName: currentTool, toolInput };
          currentTool = null;
          toolInput = '';
        }
      }

      // 完整助手消息 - 包含工具结果
      if (message.type === 'assistant') {
        for (const block of message.message.content || []) {
          if (block.type === 'tool_result') {
            yield {
              type: 'tool_result',
              toolOutput: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
            };
          }
        }
      }

      // 最终结果
      if (message.type === 'result') {
        yield {
          type: 'result',
          content: message.subtype === 'success' ? message.result : message.errors?.join('\n'),
          sessionId: newSessionId || sessionId || undefined
        };
      }
    }
  } catch (error: any) {
    yield {
      type: 'error',
      content: error.message || '未知错误'
    };
  }
}
```

### 阶段 6：消息格式化 (`formatter.ts`)

```typescript
import { ClaudeEvent } from './types';

const TOOL_ICONS: Record<string, string> = {
  'Bash': '🖥️ 执行命令',
  'Read': '📖 读取文件',
  'Write': '✏️ 写入文件',
  'Edit': '📝 编辑文件',
  'Grep': '🔍 搜索内容',
  'Glob': '📁 查找文件',
  'WebSearch': '🌐 网络搜索',
  'WebFetch': '🔗 获取网页',
  'Task': '🤖 子任务',
};

export function formatToolStart(toolName: string): string {
  return `**${TOOL_ICONS[toolName] || `🔧 ${toolName}`}**`;
}

export function formatToolEnd(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input);
    if (toolName === 'Bash' && parsed.command) {
      return `\`\`\`bash\n${parsed.command}\n\`\`\``;
    }
    if (['Read', 'Write', 'Edit'].includes(toolName) && parsed.file_path) {
      return `📄 \`${parsed.file_path}\``;
    }
    if (toolName === 'WebSearch' && parsed.query) {
      return `🔍 "${parsed.query}"`;
    }
    if (toolName === 'Grep' && parsed.pattern) {
      return `🔍 \`${parsed.pattern}\``;
    }
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return input.slice(0, 200);
  }
}

export function formatToolResult(output: string): string {
  // 截断过长的输出
  const maxLen = 500;
  const truncated = output.length > maxLen
    ? output.slice(0, maxLen) + '\n... (输出已截断)'
    : output;
  return `\`\`\`\n${truncated}\n\`\`\``;
}

export function buildFeishuCard(title: string, content: string): string {
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      title: { content: title, tag: 'plain_text' },
      template: 'blue'
    },
    elements: [
      { tag: 'markdown', content }
    ]
  });
}
```

### 阶段 7：飞书消息处理 (`feishu.ts`)

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config';
import { streamClaudeChat } from './claude';
import { formatToolStart, formatToolEnd, formatToolResult, buildFeishuCard } from './formatter';
import { MessageDedup } from './dedup';

const sessions = new Map<string, string>(); // chatId -> claudeSessionId
const dedup = new MessageDedup();

export function startFeishuBot() {
  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const message = data.event?.message;
        if (!message) return;

        // 1. 消息去重
        if (dedup.isDuplicate(message.message_id)) {
          return;
        }

        // 2. 只处理文本消息
        if (message.message_type !== 'text') {
          return;
        }

        // 3. 群聊中只响应 @机器人
        if (message.chat_type === 'group' && !message.is_mention) {
          return;
        }

        // 4. 异步处理（立即返回，避免 3 秒超时）
        setImmediate(() => {
          handleMessage(client, message).catch(console.error);
        });
      }
    })
  });

  console.log('🚀 飞书机器人已启动（WebSocket 长连接）');
}

async function handleMessage(client: Lark.Client, message: any) {
  const chatId = message.chat_id;

  // 获取消息文本
  let text: string;
  if (message.chat_type === 'group') {
    text = message.text_without_at_bot?.trim() || '';
  } else {
    try {
      text = JSON.parse(message.content).text?.trim() || '';
    } catch {
      text = '';
    }
  }

  if (!text) return;

  // 处理命令
  if (text === '/clear' || text === '/new') {
    sessions.delete(chatId);
    await sendCard(client, chatId, 'Claude Code', '✅ 会话已清除，开始新对话');
    return;
  }

  if (text === '/status') {
    const hasSession = sessions.has(chatId);
    await sendCard(client, chatId, 'Claude Code',
      hasSession ? '📍 当前有活跃会话' : '💤 无活跃会话'
    );
    return;
  }

  // 调用 Claude
  const sessionId = sessions.get(chatId) || null;
  const chunks: string[] = [];

  try {
    for await (const event of streamClaudeChat(text, sessionId)) {
      switch (event.type) {
        case 'tool_start':
          chunks.push(formatToolStart(event.toolName!));
          break;
        case 'tool_end':
          chunks.push(formatToolEnd(event.toolName!, event.toolInput!));
          break;
        case 'tool_result':
          if (event.toolOutput) {
            chunks.push(formatToolResult(event.toolOutput));
          }
          chunks.push('---');
          break;
        case 'result':
          if (event.sessionId) {
            sessions.set(chatId, event.sessionId);
          }
          if (event.content) {
            chunks.push('\n**结果：**\n' + event.content);
          }
          break;
        case 'error':
          chunks.push(`\n❌ **错误：** ${event.content}`);
          break;
      }
    }

    await sendCard(client, chatId, 'Claude Code', chunks.join('\n'));
  } catch (error: any) {
    await sendCard(client, chatId, 'Claude Code', `❌ 错误: ${error.message}`);
  }
}

async function sendCard(client: Lark.Client, chatId: string, title: string, content: string) {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: buildFeishuCard(title, content),
    }
  });
}
```

### 阶段 8：入口文件 (`index.ts`)

```typescript
import { startFeishuBot } from './feishu';

console.log('🚀 Claude Code Feishu Bot 启动中...');
console.log(`📂 工作目录: ${process.env.WORKSPACE || '/workspace'}`);
console.log(`🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? '已配置' : '未配置'}`);
console.log(`🌐 API URL: ${process.env.ANTHROPIC_BASE_URL || '默认'}`);

startFeishuBot();
```

### 阶段 9：Docker 配置

**Dockerfile：**
```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist/ ./dist/

VOLUME ["/workspace"]

CMD ["node", "dist/index.js"]
```

**docker-compose.yml：**
```yaml
version: '3.8'

services:
  project1:
    build: .
    container_name: claude-feishu-project1
    environment:
      - FEISHU_APP_ID=${FEISHU_APP_ID_1}
      - FEISHU_APP_SECRET=${FEISHU_APP_SECRET_1}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
      - WORKSPACE=/workspace
    volumes:
      - ./workspaces/project1:/workspace
    restart: unless-stopped

  project2:
    build: .
    container_name: claude-feishu-project2
    environment:
      - FEISHU_APP_ID=${FEISHU_APP_ID_2}
      - FEISHU_APP_SECRET=${FEISHU_APP_SECRET_2}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
      - WORKSPACE=/workspace
    volumes:
      - ./workspaces/project2:/workspace
    restart: unless-stopped
```

### 阶段 10：配置文件

**.env.example：**
```bash
# Claude API
ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_BASE_URL=https://your-proxy.com/v1  # 可选

# 飞书应用 1
FEISHU_APP_ID_1=cli_xxx
FEISHU_APP_SECRET_1=xxx

# 飞书应用 2 (可选)
FEISHU_APP_ID_2=cli_yyy
FEISHU_APP_SECRET_2=yyy
```

---

## 飞书配置步骤

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 添加「机器人」能力
4. 权限管理 → 添加以下权限：
   - `im:message`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - `im:message:send_as_bot`
5. 事件订阅 → 选择「使用长连接接收事件」
6. 添加事件：`im.message.receive_v1`
7. 创建版本并发布应用
8. 获取 App ID 和 App Secret

---

## 支持的命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清除上下文，开始新对话 |
| `/new` | 同 `/clear` |
| `/status` | 查看当前会话状态 |
| 其他文本 | 发送给 Claude Code |

---

## 代码量预估

| 文件 | 行数 |
|------|------|
| `src/index.ts` | ~15 行 |
| `src/config.ts` | ~15 行 |
| `src/types.ts` | ~20 行 |
| `src/dedup.ts` | ~30 行 |
| `src/claude.ts` | ~100 行 |
| `src/feishu.ts` | ~120 行 |
| `src/formatter.ts` | ~70 行 |
| Dockerfile | ~10 行 |
| docker-compose.yml | ~35 行 |
| **总计** | **~415 行** |

---

## 验证方案

1. **启动测试**：
   ```bash
   npm run dev
   # 确认 "🚀 飞书机器人已启动" 输出
   ```

2. **私聊测试**：
   - 发送 `/status` → 应返回 "💤 无活跃会话"
   - 发送 "你好" → Claude 应响应
   - 发送 `/clear` → 应返回 "✅ 会话已清除"

3. **群聊测试**：
   - 不 @机器人 发消息 → 应无响应
   - @机器人 发消息 → Claude 应响应

4. **工具调用测试**：
   - 发送 "列出当前目录的文件" → 应展示 Bash 命令和结果

---

**创建时间**：2026-02-04
**修订时间**：2026-02-04
**状态**：待确认
