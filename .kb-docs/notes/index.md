# 开发笔记

记录项目开发过程中的问题、解决方案和最佳实践。

## 修复 Codex provider 的 os error 2 间歇性失败
- **日期**: 2026-03-03
- **标签**: codex, bug-fix, logging, workspace, mcp
- **问题**: 飞书机器人在 AI_PROVIDER=codex 时，偶发返回 'Codex Exec exited with code 1: Error: No such file or directory (os error 2)'，本地与 Docker 都可能出现，且原日志信息不足。
- **解决方案**: 在 src/codex-provider.ts 增加工作目录解析与回退（WORKSPACE 不存在时回退到 process.cwd()/projectRoot）；重写 MCP 注册逻辑，按 TOML section 精确 upsert，避免注释内容误判；将 MCP command 从 'node' 改为 process.execPath 绝对路径，规避 PATH 导致的 ENOENT；补充 turn.exception/mcp.ensure/workspace.resolve 诊断日志，并保留历史日志不再每次启动清空。
- **相关文件**:
  - `src/codex-provider.ts`
- **经验教训**: Codex SDK 抛出的 os error 2 常见于 --cd 目录不存在或子进程命令路径不可达。对运行时路径（workspace/node/mcp 配置）做显式存在性校验和日志打点，可以显著降低排障成本。

## 修复同聊天并发时后续消息被丢弃的问题
- **日期**: 2026-03-03
- **标签**: feishu, bug-fix, queue, concurrency
- **问题**: 同一 chat_id 在处理上一条消息时，后续消息仅提示“上一条还在处理中”，但不会自动继续处理，导致用户需要再发一次。
- **解决方案**: 在 src/feishu.ts 新增 pendingMessages（每个聊天保留最新一条待处理消息）；当 processing 命中时入队并提示等待；当前任务 finally 释放锁后自动 dequeue 并 setImmediate 继续处理。
- **相关文件**:
  - `src/feishu.ts`
- **经验教训**: 并发保护不能只做拒绝提示，聊天机器人场景应至少提供单条排队能力，避免用户消息静默丢失。

## 增加单轮超时自动中断并释放排队消息
- **日期**: 2026-03-03
- **标签**: codex, feishu, timeout, abort, queue, bug-fix
- **问题**: 某些 Codex 会话在 turn.started 后长时间无后续事件，导致当前聊天一直处于 processing，后续消息只能排队但无法执行。
- **解决方案**: 在 src/feishu.ts 增加 chat 级超时（默认 3 分钟，可通过 CHAT_TURN_TIMEOUT_MS 配置）；超时后自动 abort 并记录 timeout 原因，卡片展示超时提示；finally 一定释放 processing 并自动处理 pending 队列。同步在 src/codex-provider.ts 将 abortSignal 传入 thread.runStreamed(prompt, { signal })，确保中断可真正传递到底层 codex exec 进程。
- **相关文件**:
  - `src/feishu.ts`
  - `src/codex-provider.ts`
- **经验教训**: 仅在上层轮询 abortSignal 不足以中断阻塞中的底层进程；必须把 AbortSignal 传入 SDK/子进程调用链，并配合超时保护防止会话永久占锁。

## send_file_to_user 支持 open_id 直发文件
- **日期**: 2026-03-03
- **标签**: feishu, feature, mcp, codex, claude
- **问题**: 原实现仅支持 chat_id 发送文件，AI 在拿到目标用户 open_id 时容易误填 chat_id 导致 400。
- **解决方案**: 更新 src/feishu-actions.ts 支持 receive_id_type（chat_id/open_id）；更新 src/mcp-server.ts 与 src/tools.ts 的 send_file_to_user 参数为 open_id/chat_id 可选并二选一；更新 src/provider.ts 系统提示和 src/formatter.ts 工具展示。
- **相关文件**:
  - `src/feishu-actions.ts`
  - `src/mcp-server.ts`
  - `src/tools.ts`
  - `src/provider.ts`
  - `src/formatter.ts`
- **经验教训**: 飞书发送接口支持 receive_id_type=open_id 直接发单聊，且响应里可回传 chat_id；工具层应避免把参数命名限制成单一路径，减少模型误用。

## 修正 Codex 私聊工作目录误报 WORKSPACE 回退日志
- **日期**: 2026-03-06
- **标签**: codex, workspace, bug-fix, logging
- **问题**: 私聊消息会显式传入用户级 workingDirectory，但 resolveWorkingDirectory 只要最终选中的目录不等于 config.workspace 就打印 'WORKSPACE 不存在，已回退到'，导致正常的用户隔离目录被误报为目录不存在。
- **解决方案**: 在 src/codex-provider.ts 中先判断 config.workspace 是否真实存在，再识别当前是否正在使用 preferredWorkingDirectory。只有在 configured WORKSPACE 不存在、且当前不是使用显式传入的会话工作目录时，才打印回退告警；同时把告警文本补充为包含原始 WORKSPACE 路径。
- **相关文件**:
  - `src/codex-provider.ts`
- **经验教训**: 带有多级候选目录的解析逻辑，日志条件要区分 '显式优先目录' 与 '异常回退'，否则在多租户/会话隔离场景下很容易产生误导性告警。

## 为开发者 open_id 增加本机目录直连映射
- **日期**: 2026-03-06
- **标签**: feishu, workspace, developer, feature
- **问题**: 默认私聊目录会落到项目内的 workspace/user_<open_id>。开发者自己调试时，希望命中指定 open_id 后直接使用本机用户目录，便于访问本地工程与文件。
- **解决方案**: 新增 DEVELOPER_OPEN_ID 和 DEVELOPER_WORKSPACE 配置；在 feishu.ts 的 resolveMessageWorkingDirectory 中优先判断私聊发送者是否命中开发者 open_id，命中则直接返回开发者目录，否则继续走原来的 user_<open_id> 隔离目录。并把本地 .env 写入为 ou_d5ab33ba157d48139acb3b2c2b131036 -> /Users/jiangjiwei。
- **相关文件**:
  - `src/config.ts`
  - `src/feishu.ts`
  - `.env.example`
  - `README.md`
  - `doc/multi-user.md`
- **经验教训**: 用户级工作目录策略里如果存在开发者调试诉求，最好预留显式 override，而不是把个人特例硬编码进默认目录规则。
