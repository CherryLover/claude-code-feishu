# 文件结构重构方案

## 当前问题
- 根目录文件过多，职责不清晰
- bot-* 文件命名不统一
- feishu 相关文件分散
- 缺少清晰的分层

## 建议结构

```
src/
├── index.ts                    # 入口
├── config.ts                   # 全局配置
│
├── core/                       # 核心业务逻辑
│   ├── bot-runner.ts          # 机器人运行器
│   ├── bot-worker.ts          # 工作进程
│   ├── bot-env.ts             # 环境配置
│   ├── task-executor.ts       # 任务执行器
│   ├── task-progress.ts       # 进度管理
│   └── dedup.ts               # 消息去重
│
├── providers/                  # AI Provider 层
│   ├── index.ts               # Provider 路由
│   ├── claude.ts              # Claude SDK
│   ├── codex.ts               # Codex SDK (重命名)
│   └── types.ts               # Provider 类型定义
│
├── feishu/                     # 飞书集成层
│   ├── client.ts              # WebSocket 客户端 (原 feishu.ts)
│   ├── api.ts                 # 飞书 API (原 feishu-api.ts)
│   ├── messages.ts            # 消息发送 (原 feishu-messages.ts)
│   ├── actions.ts             # 动作处理 (原 feishu-actions.ts)
│   └── formatter.ts           # 卡片格式化
│
├── scheduler/                  # 定时任务模块
│   ├── index.ts               # 导出
│   ├── cli.ts                 # CLI 工具 (原 scheduler-cli.ts)
│   ├── db.ts
│   ├── runner.ts
│   ├── service.ts
│   ├── actions.ts
│   └── types.ts
│
├── tools/                      # MCP 工具层
│   ├── index.ts               # 工具注册
│   ├── mcp-server.ts          # MCP 服务器
│   └── file-utils.ts          # 文件工具
│
└── types/                      # 全局类型
    └── index.ts               # 统一导出
```

## 重构步骤

### 阶段 1: 创建新目录结构
1. 创建 core/, providers/, feishu/, tools/, types/ 目录
2. 不移动文件，先确保目录存在

### 阶段 2: 移动和重命名文件
1. **core/** - 移动核心业务文件
   - bot-runner.ts, bot-worker.ts, bot-env.ts
   - task-executor.ts, task-progress.ts
   - dedup.ts

2. **providers/** - 整合 AI Provider
   - provider.ts → providers/index.ts
   - claude.ts → providers/claude.ts
   - codex-provider.ts → providers/codex.ts
   - types.ts → providers/types.ts

3. **feishu/** - 整合飞书相关
   - feishu.ts → feishu/client.ts
   - feishu-api.ts → feishu/api.ts
   - feishu-messages.ts → feishu/messages.ts
   - feishu-actions.ts → feishu/actions.ts
   - formatter.ts → feishu/formatter.ts

4. **tools/** - 工具层
   - tools.ts → tools/index.ts
   - mcp-server.ts → tools/mcp-server.ts
   - file-utils.ts → tools/file-utils.ts

5. **scheduler/** - 添加索引文件
   - 添加 scheduler/index.ts
   - scheduler-cli.ts → scheduler/cli.ts

### 阶段 3: 更新导入路径
1. 更新 index.ts 中的导入
2. 更新各模块间的相互引用
3. 更新 package.json 中的脚本路径

### 阶段 4: 测试验证
1. 编译检查: `npm run build`
2. 功能测试: `npm run dev`
3. 确保所有功能正常

## 优势
- ✅ 清晰的分层架构
- ✅ 按功能模块组织
- ✅ 更好的可维护性
- ✅ 便于新功能扩展
- ✅ 降低文件查找成本

## 风险
- 需要更新大量导入路径
- 可能影响正在开发的功能
- 需要完整的回归测试

## 建议
建议分阶段执行，每个阶段完成后进行测试，确保功能正常再进行下一阶段。
