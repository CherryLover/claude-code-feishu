# 功能清单

记录项目已实现的功能、入口、流程和关键文件。

## 单用户根目录工作模式
- **标签**: feishu, single-user, workspace, claude, codex
- **描述**: 统一取消按飞书用户分配独立目录，所有消息直接使用单一根目录作为工作目录。
- **入口**: 飞书消息处理入口 `src/feishu.ts:handleMessage`
- **核心流程**:
  1. 消息进入后不再根据 `chatType` 或 `senderOpenId` 动态映射目录。
  2. 统一使用 `MESSAGE_WORKSPACE`（默认当前系统用户目录，兼容旧的 `DEVELOPER_WORKSPACE`）作为工作目录。
  3. 执行前仅校验目录存在且可读写，不再自动创建 `workspace/user_<open_id>` 一类目录。
  4. workingDirectory 继续透传到 Claude/Codex provider，保持工具调用行为不变。
- **关键文件**:
  - `src/config.ts` - 增加单用户消息工作目录配置解析
  - `src/feishu.ts` - 工作目录选择、访问校验、启动通知与运行日志
  - `src/provider.ts` - 统一 provider 层透传 workingDirectory
  - `src/claude.ts` - Claude query cwd 支持会话级目录
  - `src/codex-provider.ts` - Codex workingDirectory 支持会话级目录
  - `README.md` - 文档改为单用户工作目录说明
  - `doc/multi-user.md` - 记录多用户方案已下线，保留单用户模式说明
- **备注**: 会话隔离仍按聊天 / topic 维持，但文件系统工作目录不再按用户拆分。

## 单用户访问限制
- **标签**: feishu, single-user, auth, access-control
- **描述**: 在消息入口直接校验发送者用户名，仅允许指定用户继续使用机器人。
- **入口**: 飞书消息入口 `src/feishu.ts:handleMessage` 与菜单事件入口 `src/feishu.ts:handleMenuEvent`
- **核心流程**:
  1. 配置 `AUTHORIZED_USER_NAME` 作为唯一允许用户。
  2. 收到消息或菜单事件后，先读取发送者姓名。
  3. 若姓名不匹配，则直接返回未开放提示并结束，不再进入 AI、会话和工作目录逻辑。
  4. 若匹配，再继续执行原有命令、会话和工具调用流程。
- **关键文件**:
  - `src/config.ts` - 增加单用户访问限制配置解析
  - `src/feishu.ts` - 在消息入口和菜单事件入口增加授权校验与未授权提示
  - `README.md` - 补充 `AUTHORIZED_USER_NAME` 的配置说明
  - `doc/multi-user.md` - 记录多用户已下线后的单用户访问方式
- **备注**: 这层限制发生在 AI 调用前，未授权请求不会占用会话、工作目录或模型额度。

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

## 两人群免 @ 与话题群进度卡降级
- **标签**: feishu, group-chat, topic, ux, bot
- **描述**: 群聊场景下，识别 1 用户 + 1 机器人 的直连群并允许免 @ 触发，同时在话题模式群中关闭进度卡。
- **入口**: 飞书消息处理入口 src/feishu.ts:handleMessage
- **核心流程**:
  1. 收到群消息后先通过 im.chat.get 拉取并缓存群元信息，识别 group_message_type、user_count、bot_count
  2. 若群内计数为 1 个用户 + 1 个机器人，则即使未 @ 机器人也继续处理消息
  3. 若群为话题模式（group_message_type=thread），跳过等待卡和执行进度卡，只保留最终 reply
  4. 群信息读取失败时回退到原有行为，避免误放开普通群消息
- **关键文件**:
  - `src/feishu.ts` - 新增群信息缓存、两人群免 @ 判定、话题群进度卡关闭逻辑
  - `scripts/check-feishu-permissions.mjs` - 新增群信息读取探针，便于验证话题群识别依赖
  - `README.md` - 补充两人群直连、话题群降级和额外群消息权限说明
- **备注**: 两人群免 @ 还依赖飞书开放平台允许机器人接收群内非 @ 消息；未开通时，代码已就绪但平台侧仍只会投递 @ 消息。

## 飞书多主题群聊会话恢复
- **标签**: feishu, topic-group, session, recovery
- **描述**: 为多主题群聊增加 topic 级会话持久化与重启后的历史回填兜底。
- **入口**: 飞书消息入口 `src/feishu.ts` 的 `handleMessage`，仅在多主题群聊的 thread/topic 场景触发。
- **核心流程**:
  1. 收到多主题群聊消息后，按 `chatId + threadId` 构造 sessionKey。
  2. 优先从本地 topic 会话缓存恢复 sessionId。
  3. 如果没有可恢复 sessionId，则拉取当前 thread 的历史消息并导出为 Markdown 文件。
  4. 把历史文件路径拼入当前 prompt，提示 AI 把它当作之前的会话记录继续回答。
  5. 成功返回后把 sessionId、threadId、历史文件路径和上下文起点重新写回本地缓存。
- **关键文件**:
  - `src/feishu.ts` - 实现 topic 会话缓存、历史拉取导出、prompt 回填和重启恢复主流程。
  - `src/feishu-messages.ts` - 支持 reply_in_thread，确保多主题群聊回复落回对应 thread。
- **备注**: `/clear` 和 `/new` 会把 topic 会话重置为新上下文，并记录 contextStartTimeMs，避免历史回填时把清空前的旧对话重新喂给模型；恢复上下文用的历史 Markdown 在当前轮 AI 真正开始读取后会立即在收尾阶段删除，并同步清空缓存里的文件路径。
