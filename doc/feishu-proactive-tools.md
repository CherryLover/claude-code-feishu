# 飞书主动交互工具设计文档

## 概述

扩展飞书机器人能力，让 AI 能够主动与组织内用户交互，包括：
- 搜索/查找组织内用户
- 给指定用户发送私聊消息
- 创建飞书待办任务并指派给用户
- 创建日程/会议并邀请参与者

## 使用场景

```
用户：帮我给张三发个消息，说 A 项目的接口已经联调完成了，
     再给他创建一个待办提醒他周五前完成测试，
     顺便约个下周一下午3点的会议 review 一下

AI：好的，我来处理：
    1. 查找用户「张三」... 找到 张三 (zhangsan@company.com)
    2. 发送消息... 已发送
    3. 创建待办「完成 A 项目测试」(截止: 周五)... 已创建
    4. 创建会议「A 项目 Review」(下周一 15:00)... 已创建
```

## 权限配置

### API 权限（已配置）

| 分类 | Scope | 说明 |
|------|-------|------|
| 通讯录 | `contact:user.base:readonly` | 获取用户基本信息 |
| 通讯录 | `contact:user.id:readonly` | 通过手机号/邮箱获取用户 ID |
| 通讯录 | `contact:user:search` | 搜索组织内用户 |
| 通讯录 | `contact:user.email:readonly` | 获取用户邮箱（可选） |
| 通讯录 | `contact:user.phone:readonly` | 获取用户手机号（可选） |
| 通讯录 | `contact:user.department:readonly` | 获取用户部门信息（可选） |
| 通讯录 | `contact:department.base:readonly` | 获取部门基础信息（可选） |
| 任务 | `task:task` | 创建、查看、修改、删除任务 |
| 日历 | `calendar:calendar` | 全部日历接口授权 |

### 通讯录权限范围

需要在飞书后台配置「通讯录权限范围」为「全部成员」或指定部门。

## 工具设计

### 1. search_user - 搜索用户

在组织通讯录中搜索用户。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索关键词（姓名、邮箱、手机号） |

**返回：**
```json
{
  "users": [
    {
      "user_id": "ou_xxx",
      "open_id": "ou_xxx",
      "name": "张三",
      "email": "zhangsan@company.com",
      "mobile": "+86 13800138000",
      "department": "研发部"
    }
  ]
}
```

**API 调用：**
- `POST /contact/v3/users/batch_get_id` - 通过邮箱/手机号精确查找
- `POST /search/v2/user` - 模糊搜索（需要 `search:user` 权限，备选方案）

### 2. send_message_to_user - 发送私聊消息

给指定用户发送私聊消息。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | string | 是 | 用户 ID（open_id 或 user_id） |
| content | string | 是 | 消息内容（支持 Markdown） |

**返回：**
```json
{
  "success": true,
  "message_id": "om_xxx"
}
```

**API 调用：**
- `POST /im/v1/messages?receive_id_type=open_id`

**注意事项：**
- 用户必须与机器人有过交互（打开过机器人聊天），否则无法发送
- 如果用户未开启机器人，返回错误提示

### 3. create_task - 创建待办任务

创建飞书待办任务并指派给用户。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 任务标题 |
| assignee_id | string | 是 | 执行者用户 ID |
| due_date | string | 否 | 截止日期（ISO 8601 格式） |
| description | string | 否 | 任务描述 |

**返回：**
```json
{
  "success": true,
  "task_id": "t_xxx",
  "url": "https://feishu.cn/task/xxx"
}
```

**API 调用：**
- `POST /task/v2/tasks` - 创建任务
- `POST /task/v2/tasks/:task_id/members` - 添加执行者

**请求体示例：**
```json
{
  "summary": "完成 A 项目测试",
  "description": "接口联调已完成，请完成集成测试",
  "due": {
    "timestamp": "1704067200",
    "is_all_day": true
  },
  "members": [
    {
      "id": "ou_xxx",
      "type": "user",
      "role": "assignee"
    }
  ]
}
```

### 4. create_calendar_event - 创建日程/会议

创建日程并邀请参与者。

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 日程标题 |
| start_time | string | 是 | 开始时间（ISO 8601） |
| end_time | string | 否 | 结束时间（默认 1 小时后） |
| attendees | string[] | 是 | 参与者用户 ID 列表 |
| description | string | 否 | 日程描述 |
| location | string | 否 | 地点 |
| need_meeting | boolean | 否 | 是否创建视频会议（默认 true） |

**返回：**
```json
{
  "success": true,
  "event_id": "e_xxx",
  "url": "https://feishu.cn/calendar/xxx",
  "meeting_url": "https://meetings.feishu.cn/xxx"
}
```

**API 调用：**
- `GET /calendar/v4/calendars` - 获取主日历 ID
- `POST /calendar/v4/calendars/:calendar_id/events` - 创建日程

**请求体示例：**
```json
{
  "summary": "A 项目 Review 会议",
  "description": "Review 联调完成的接口",
  "start_time": {
    "timestamp": "1704096000"
  },
  "end_time": {
    "timestamp": "1704099600"
  },
  "vchat": {
    "vc_type": "vc"
  },
  "attendee_ability": "can_modify_event",
  "attendees": [
    {
      "type": "user",
      "user_id": "ou_xxx"
    }
  ]
}
```

## 实现计划

### Phase 1: 基础设施

1. **创建 `src/feishu-api.ts`** - 飞书 API 封装
   - Token 管理（tenant_access_token 获取与缓存）
   - 统一请求封装（错误处理、重试）
   - 类型定义

2. **扩展 `src/tools.ts`** - 注册新工具
   - 定义工具 schema
   - 实现工具处理函数

### Phase 2: 用户搜索

1. 实现 `searchUser` 函数
2. 支持姓名模糊搜索
3. 支持邮箱/手机号精确查找
4. 返回用户基本信息

### Phase 3: 消息发送

1. 实现 `sendMessageToUser` 函数
2. 支持富文本 Markdown
3. 处理用户未开启机器人的情况

### Phase 4: 待办任务

1. 实现 `createTask` 函数
2. 支持设置截止日期
3. 支持任务描述
4. 返回任务链接

### Phase 5: 日程会议

1. 实现 `createCalendarEvent` 函数
2. 自动获取机器人主日历
3. 支持创建视频会议
4. 支持多人邀请

## 文件结构

```
src/
├── feishu.ts           # 现有：WebSocket 连接、消息处理
├── feishu-api.ts       # 新增：飞书 REST API 封装
├── feishu-tools.ts     # 新增：飞书主动交互工具
├── tools.ts            # 扩展：注册新工具
└── types.ts            # 扩展：新类型定义
```

## API 参考

- [搜索用户](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch_get_id)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [创建任务](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/task-v2/task/create)
- [创建日程](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/calendar-v4/calendar-event/create)

## 注意事项

1. **用户 ID 类型**
   - 飞书有多种用户 ID：`open_id`、`user_id`、`union_id`
   - 推荐统一使用 `open_id`，跨应用通用

2. **消息发送限制**
   - 用户必须先打开过机器人聊天窗口
   - 否则需要引导用户先与机器人建立对话

3. **日历权限**
   - 机器人只能操作自己的主日历或有写权限的共享日历
   - 邀请参与者需要参与者接受邀请

4. **Token 缓存**
   - `tenant_access_token` 有效期 2 小时
   - 需要实现自动刷新机制

5. **错误处理**
   - 用户不存在
   - 无权限访问用户信息
   - 消息发送失败（用户未开启机器人）
   - 日历冲突
