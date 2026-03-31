# 单用户工作目录模式（原多用户方案已下线）

## 当前行为

- 所有飞书消息统一使用同一个工作目录。
- 可通过 `AUTHORIZED_USER_NAME` 把机器人限制为只允许一个飞书用户名使用。
- 默认工作目录为当前系统用户目录；如需覆盖，可设置 `MESSAGE_WORKSPACE`。
- 为兼容旧配置，也会读取 `DEVELOPER_WORKSPACE` 作为 `MESSAGE_WORKSPACE` 的回退值。
- 不再按 `open_id` 动态创建 `workspace/user_<open_id>` 一类目录。
- Claude / Codex 仍会收到 `workingDirectory`，只是这个目录现在固定为单一目录。

## 会保留的隔离能力

- **会话隔离**：仍按聊天 / topic 维护 session，不影响多轮上下文。
- **并发控制**：仍按聊天 / topic 控制串行处理，避免同一会话并发冲突。
- **用户身份透传**：`senderOpenId` / `senderName` 仍会传给 Provider，用于上下文和工具执行。

## 不再支持的能力

- 不再允许未授权用户继续使用机器人。
- 不再为不同私聊用户自动分配独立目录。
- 不再基于 `DEVELOPER_OPEN_ID` 判断是否切换到开发者目录。
- 不再在首次请求时自动创建用户工作目录。

## 配置建议

```bash
# 只允许一个飞书用户使用
AUTHORIZED_USER_NAME=张三

# 默认可不配，直接使用当前系统用户目录
MESSAGE_WORKSPACE=/Users/yourname
```

如果你保留了旧环境变量：

```bash
DEVELOPER_WORKSPACE=/Users/yourname
```

服务仍会兼容读取，但更推荐逐步切换到 `MESSAGE_WORKSPACE`。
