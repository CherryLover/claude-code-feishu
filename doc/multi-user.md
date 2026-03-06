# 多用户支持方案

## 现状分析

### 已支持

- **会话隔离（按 chatId）**：`sessions` Map 以 `chatId` 为 key，不同聊天窗口各自维护独立 Claude 会话
- **并发控制（按 chatId）**：`processing` Set 防止同一聊天内并发请求
- **私聊 + 群聊**：私聊和群聊都能响应，群聊只响应 @机器人的消息
- **私聊目录隔离（按 open_id）**：私聊消息自动使用 `<项目目录>/workspace/user_<open_id>`，首次请求自动创建目录
- **开发者目录特例**：当私聊发送者 `open_id` 命中 `DEVELOPER_OPEN_ID` 时，优先使用 `DEVELOPER_WORKSPACE`（默认当前系统用户目录）
- **用户身份传递**：`senderOpenId` / `senderName` 会透传给 Provider，用于上下文和工具执行

### 不足

| 问题 | 说明 |
|------|------|
| 群聊无用户级隔离 | 同一群里多人共享 Claude 会话，`/clear` 会影响所有人 |
| 群聊并发阻塞 | 按 `chatId` 加锁，群聊中一人使用时其他人被阻塞 |
| 进程级不隔离 | 所有用户仍在同一进程内运行，共享 CPU/内存上限 |

### 多用户场景支持情况

| 场景 | 是否支持 |
|------|---------|
| 多个私聊用户同时使用 | 支持（各自独立 chatId） |
| 同一群里多人使用 | 不支持（共享会话，互相干扰） |
| 用户级工作目录隔离 | 私聊支持（`<项目目录>/workspace/user_<open_id>`）；群聊不支持 |

## 方案对比

### 方案一：代码层隔离（已实现）

按 userId 隔离私聊工作目录。

**改动点：**

1. `feishu.ts` 从私聊消息提取 `senderOpenId`
2. 映射目录为 `<项目目录>/workspace/user_<open_id>` 并自动创建
3. 通过 `streamChat` 透传 `workingDirectory` 到 Claude/Codex 执行链

**目录结构：**

```
/workspace/
  ├── shared/          ← 群聊/非私聊共享目录
  ├── user_ou_xxxx1/   ← 用户A（自动创建）
  ├── user_ou_xxxx2/   ← 用户B（自动创建）
  └── user_ou_xxxx3/   ← 用户C（自动创建）
```

**Docker 部署只需挂载总目录：**

```yaml
volumes:
  - ./workspace:/workspace
```

**优点：** 改动小、部署简单、资源占用低
**缺点：** 进程级别不隔离，共用一个 Claude Code 实例

### 方案二：每人一个 Docker 容器

一个飞书 Bot + 调度层 + 每个用户一个独立 Claude Code 容器。

**架构：**

```
飞书 WebSocket (1个)
       |
  路由/调度层 (1个容器)
       | 按 userId 分发
  +---------+---------+
  v         v         v
容器A     容器B     容器C
```

> 注意：飞书 Bot 的 WebSocket 连接只能有一个消费者，不能让每个容器各自连飞书，必须有一个调度层。

**优点：** 完全隔离（进程、文件系统、资源）
**缺点：** 需要容器编排和调度层，复杂度高，资源占用大

## 结论

当前实现已覆盖“多人私聊同一个机器人”的目录隔离需求。只有需要进程级完全隔离时再考虑方案二。
