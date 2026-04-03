# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

飞书机器人，通过飞书 WebSocket 长连接接收消息，调用 Claude Agent SDK 或 Codex SDK 处理请求，并将中间过程和结果以 Markdown 卡片形式返回给用户。

## 常用命令

```bash
# 开发运行
npm run dev

# 构建
npm run build

# 生产运行
npm run start
```

## 架构

```
用户消息 → 飞书 WebSocket → 消息去重 → 异步处理(避免3秒超时)
                                         ↓
                            Provider 路由 (Claude / Codex)
                                         ↓
                            格式化 Markdown → 飞书卡片消息
```

## 项目结构

```
src/
├── config.ts                   # 全局配置与环境变量
├── index.ts                    # 入口，多 Provider 启动器
│
├── core/                       # 核心业务逻辑
│   ├── bot-runner.ts          # 单 Provider 运行器
│   ├── bot-worker.ts          # Worker 进程封装
│   ├── bot-env.ts             # 环境变量覆盖逻辑
│   ├── task-executor.ts       # AI 任务执行器
│   ├── task-progress.ts       # 进度状态管理
│   └── dedup.ts               # 消息去重（5分钟TTL）
│
├── providers/                  # AI Provider 层
│   ├── index.ts               # Provider 路由
│   ├── claude.ts              # Claude Agent SDK 封装
│   ├── codex.ts               # Codex SDK 封装
│   └── types.ts               # 统一事件类型定义
│
├── feishu/                     # 飞书集成层
│   ├── client.ts              # WebSocket 客户端与消息分发
│   ├── api.ts                 # 飞书 REST API 封装
│   ├── messages.ts            # 消息发送与卡片更新
│   ├── actions.ts             # 飞书操作（文件上传等）
│   └── formatter.ts           # 工具调用格式化与卡片构建
│
├── scheduler/                  # 定时任务模块
│   ├── index.ts               # 模块导出
│   ├── cli.ts                 # CLI 管理工具
│   ├── db.ts                  # SQLite 数据库操作
│   ├── runner.ts              # 任务执行器
│   ├── service.ts             # Cron 调度服务
│   ├── actions.ts             # 任务管理操作
│   └── types.ts               # 类型定义
│
└── tools/                      # MCP 工具层
    ├── index.ts               # Claude Agent SDK MCP 工具
    ├── mcp-server.ts          # Codex CLI stdio MCP 服务器
    └── file-utils.ts          # 文件类型识别工具
```

### 核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口** | `index.ts` | 多 Provider 启动器，Worker 管理 |
| **核心** | `core/bot-runner.ts` | 单 Provider 运行器 |
| | `core/task-executor.ts` | AI 任务执行，超时控制，进度回调 |
| | `core/task-progress.ts` | 进度状态管理与渲染 |
| | `core/dedup.ts` | 消息去重（5 分钟 TTL） |
| **Provider** | `providers/index.ts` | AI Provider 路由 |
| | `providers/claude.ts` | Claude Agent SDK 封装 |
| | `providers/codex.ts` | Codex SDK 封装 |
| | `providers/types.ts` | ClaudeEvent 统一事件类型 |
| **飞书** | `feishu/client.ts` | WebSocket 连接、消息分发、会话管理 |
| | `feishu/messages.ts` | 消息发送、卡片更新 |
| | `feishu/formatter.ts` | 工具调用格式化、卡片构建 |
| | `feishu/actions.ts` | 文件上传等操作 |
| **工具** | `tools/index.ts` | 自定义 MCP 工具（文件发送） |
| | `tools/file-utils.ts` | 文件类型识别 |
| **定时任务** | `scheduler/service.ts` | Cron 调度服务 |
| | `scheduler/runner.ts` | 任务执行与飞书推送 |

### 关键设计

1. **3 秒超时处理**: 事件处理器立即返回，使用 `setImmediate()` 异步处理 AI 调用
2. **会话管理**: `Map<chatId, sessionId>` 存储会话映射，支持 `/clear`、`/new` 清除
3. **并发控制**: `Set<chatId>` 跟踪处理中的聊天，避免同一聊天并发请求
4. **群聊处理**: 只响应 @机器人 的消息，自动清理 @mention 文本
5. **统一事件模型**: 两个 Provider 输出相同的 `ClaudeEvent` 类型，上层无需区分

### Claude Agent SDK 事件流

```
system(init) → stream_event(content_block_start) → stream_event(content_block_delta)
            → stream_event(content_block_stop) → assistant(tool_result) → result
```

关键配置:
- `includePartialMessages: true` - 获取流式事件
- `permissionMode: 'bypassPermissions'` - 跳过权限确认
- `resume: sessionId` - 恢复会话

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `AI_PROVIDER` | 否 | AI 提供商，`claude`（默认）或 `codex` |
| `ANTHROPIC_API_KEY` | Claude 时必需 | Claude API 密钥 |
| `ANTHROPIC_BASE_URL` | 否 | Claude API 代理地址 |
| `OPENAI_API_KEY` | Codex 时必需 | OpenAI / Codex API 密钥 |
| `OPENAI_BASE_URL` | 否 | OpenAI API 代理地址 |
| `FEISHU_APP_ID` | 是 | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 是 | 飞书应用密钥 |
| `WORKSPACE` | 否 | AI 工作目录，默认 `/workspace` |
| `NOTIFY_USER_ID` | 否 | 启动时通知的用户 ID |

## 飞书权限要求

### 应用权限

- `im:message` — 消息基础权限
- `im:message:send_as_bot` — 以机器人身份发送消息
- `im:message.p2p_msg:readonly` — 接收私聊消息
- `im:message.group_at_msg:readonly` — 接收群聊中 @机器人 的消息
- `im:resource` — 上传图片和文件

### 事件订阅

- `im.message.receive_v1` — 接收用户消息
- `application.bot.menu_v6` — 自定义菜单命令
- `card.action.trigger` — 卡片按钮回调
