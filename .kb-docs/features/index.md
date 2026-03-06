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
