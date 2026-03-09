# 功能清单

记录项目已实现的功能、入口、流程和关键文件。

## 私聊用户工作目录隔离
- **标签**: feishu, multi-user, workspace, claude, codex
- **描述**: 私聊场景按发送者 open_id 自动切换到独立目录，避免多人文件互相影响。
- **入口**: 飞书私聊消息处理入口 src/feishu.ts:handleMessage
- **核心流程**:
  1. 解析 senderOpenId 与 chatType，私聊时生成 <项目目录>/workspace/user_<open_id> 目录
  2. 首次消息自动 mkdir -p 目录并记录运行日志
  3. workingDirectory 通过 streamChat 透传到 Claude/Codex provider
  4. Claude query.cwd 与 Codex thread.workingDirectory 均使用该目录
- **关键文件**:
  - `src/feishu.ts` - 私聊目录映射、目录创建、workingDirectory 透传
  - `src/types.ts` - StreamChatOptions 新增 workingDirectory
  - `src/provider.ts` - 统一 provider 层透传 workingDirectory
  - `src/claude.ts` - Claude query cwd 支持会话级目录
  - `src/codex-provider.ts` - Codex workingDirectory 支持会话级目录
  - `README.md` - 文档补充私聊目录隔离说明
  - `doc/multi-user.md` - 多用户方案文档更新为已实现状态
- **备注**: 适用于多人私聊同一个机器人；群聊仍按 chatId 共享上下文与并发锁。

## 进度卡追加 Usage 统计
- **标签**: feishu, ui, reply, claude, codex
- **描述**: 将最终回复中的 Token 与上下文统计迁移到进度卡尾部，避免正文和统计信息混在一起。
- **入口**: 飞书消息处理入口 src/feishu.ts:handleMessage
- **核心流程**:
  1. 在 result 事件中把 usage 信息写入 ProgressCardState
  2. getProgressCardMarkdown 根据配置在进度卡尾部追加 usage markdown
  3. 最终 reply 默认只发送答案正文；仅在进度卡发送失败时回退到 reply 尾部
- **关键文件**:
  - `src/feishu.ts` - 进度卡状态、usage 追加逻辑和最终 reply 的兜底逻辑
  - `README.md` - 同步更新 usage 展示位置和环境变量说明
- **备注**: Claude 保留上下文窗口占用与剩余比例展示；Codex 保留输入输出 Token 与费用展示。

## SQLite 定时任务调度与飞书主动推送
- **标签**: feature, scheduler, sqlite, feishu, cron
- **描述**: 新增基于 SQLite 的单实例定时任务能力，可按 cron 执行 AI 任务并主动推送飞书结果。
- **入口**: 启动机器人时读取 SCHEDULER_ENABLED；本地通过 npm run schedule -- <command> 管理任务。
- **核心流程**:
  1. 配置模块读取 SCHEDULER_ENABLED、SCHEDULER_DB_PATH、SCHEDULER_TASK_TIMEOUT_MS。
  2. feishu.ts 启动时创建 Lark Client，并在启用时启动 SchedulerService。
  3. SchedulerService 从 SQLite 加载 enabled 任务，用 node-cron 注册本地调度。
  4. 触发后 runner 调用 executeTask 复用现有 Provider 执行链，并将结果主动发送到 chat_id 或 open_id。
  5. schedule_runs 记录每次执行状态、输出消息 ID 和错误信息；scheduler-cli 提供增删改查和手动执行。
- **关键文件**:
  - `src/config.ts` - 新增定时任务配置项和默认 SQLite 路径
  - `src/feishu.ts` - 启动时接入 SchedulerService，并复用公共执行器处理消息
  - `src/feishu-messages.ts` - 抽离飞书消息发送、reply、卡片更新和 usage 展示
  - `src/task-executor.ts` - 抽离 AI 执行与超时/中断/进度处理公共逻辑
  - `src/task-progress.ts` - 统一任务进度状态和卡片 markdown 渲染
  - `src/scheduler/db.ts` - SQLite 建表、任务 CRUD 和运行记录读写
  - `src/scheduler/service.ts` - node-cron 注册、重载和手动触发入口
  - `src/scheduler/runner.ts` - 定时任务执行、飞书推送和运行记录收尾
  - `src/scheduler-cli.ts` - 本地 schedule CLI，支持 list/add/update/enable/disable/delete/run/runs
  - `README.md` - 补充定时任务环境变量、CLI 用法和结构说明
- **备注**: 当前实现按单实例设计，不处理多实例重复触发；Docker Compose 示例已透传调度环境变量。
