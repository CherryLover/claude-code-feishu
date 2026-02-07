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

### 核心模块

| 文件 | 职责 |
|------|------|
| `src/feishu.ts` | 飞书 WebSocket 连接、消息分发、会话管理、并发控制 |
| `src/provider.ts` | AI Provider 路由，根据配置分发到 Claude 或 Codex |
| `src/claude.ts` | Claude Agent SDK 封装，AsyncGenerator 流式输出事件 |
| `src/codex-provider.ts` | Codex SDK 封装，AsyncGenerator 流式输出事件 |
| `src/formatter.ts` | 工具调用格式化（Bash/Read/Write/Grep 等），飞书卡片构建 |
| `src/tools.ts` | 自定义 MCP 工具（文件发送：图片、音频、文档） |
| `src/file-utils.ts` | 文件类型识别（图片/音频/文档分类） |
| `src/dedup.ts` | 消息去重（5 分钟 TTL，10000 条上限） |
| `src/config.ts` | 环境变量读取与校验（dotenv override 模式） |
| `src/types.ts` | ClaudeEvent 统一事件类型定义 |

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
