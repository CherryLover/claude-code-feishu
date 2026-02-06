import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config';
import { streamClaudeChat } from './claude';
import { formatToolStart, formatToolEnd, formatToolResult, buildFeishuCard } from './formatter';
import { MessageDedup } from './dedup';
import { createFeishuToolsServer } from './tools';

const sessions = new Map<string, string>(); // chatId -> claudeSessionId
const dedup = new MessageDedup();
// 跟踪正在处理中的聊天，避免并发
const processing = new Set<string>();

// 模块级 client，供启动通知使用
let feishuClient: Lark.Client | null = null;

export function startFeishuBot() {
  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });
  feishuClient = client;

  const wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const message = data.message;
        if (!message) return;

        // 1. 消息去重
        if (dedup.isDuplicate(message.message_id)) {
          console.log(`[跳过] 重复消息: ${message.message_id}`);
          return;
        }

        // 2. 只处理文本消息
        if (message.message_type !== 'text') {
          console.log(`[跳过] 非文本消息: ${message.message_type}`);
          return;
        }

        // 3. 群聊中只响应 @机器人的消息
        const chatType = message.chat_type;
        if (chatType === 'group') {
          const mentions = data.message?.mentions;
          if (!mentions || mentions.length === 0) {
            return;
          }
        }

        const senderId = data.sender?.sender_id?.open_id || 'unknown';
        console.log(`[收到消息] ${chatType === 'group' ? '群聊' : '私聊'} | chat_id: ${message.chat_id} | sender: ${senderId}`);

        // 4. 异步处理（立即返回，避免 3 秒超时）
        setImmediate(() => {
          handleMessage(client, data).catch((err) => {
            console.error('[错误] 处理消息失败:', err);
          });
        });
      },
    }),
  });

  console.log('飞书机器人已启动（WebSocket 长连接）');

  // 发送启动通知
  if (config.notifyUserId) {
    // 延迟 2 秒等待 WebSocket 连接建立
    setTimeout(() => {
      sendStartupNotification(client);
    }, 2000);
  }
}

async function sendStartupNotification(client: Lark.Client) {
  const userId = config.notifyUserId;
  const isOpenId = userId.startsWith('ou_');

  console.log(`[启动通知] 发送到 ${userId}`);

  try {
    await client.im.message.create({
      params: { receive_id_type: isOpenId ? 'open_id' : 'chat_id' },
      data: {
        receive_id: userId,
        msg_type: 'interactive',
        content: buildFeishuCard('Claude Code', `✅ 机器人已启动\n\n工作目录: \`${config.workspace}\``),
      },
    });
    console.log(`[启动通知] 发送成功`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[启动通知] 发送失败: ${errMsg}`);
  }
}

async function handleMessage(client: Lark.Client, data: any) {
  const message = data.message;
  const chatId = message.chat_id;

  // 防止同一个聊天并发处理
  if (processing.has(chatId)) {
    console.log(`[跳过] 聊天 ${chatId} 正在处理中`);
    await sendCard(client, chatId, 'Claude Code', '⏳ 上一条消息还在处理中，请稍候...');
    return;
  }

  // 获取消息文本
  let text = '';
  try {
    const parsed = JSON.parse(message.content);
    text = parsed.text?.trim() || '';
  } catch {
    return;
  }

  // 群聊中去掉 @机器人 的部分
  if (message.chat_type === 'group' && data.message?.mentions) {
    for (const mention of data.message.mentions) {
      text = text.replace(`@_user_${mention.id?.union_id}`, '').trim();
      // 也清理 @用户名 格式
      if (mention.name) {
        text = text.replace(`@${mention.name}`, '').trim();
      }
    }
  }

  if (!text) return;

  console.log(`[消息内容] "${text}"`);

  // 处理命令
  if (text === '/clear' || text === '/new') {
    console.log(`[命令] 清除会话`);
    sessions.delete(chatId);
    await sendCard(client, chatId, 'Claude Code', '✅ 会话已清除，开始新对话');
    return;
  }

  if (text === '/status') {
    console.log(`[命令] 查询状态`);
    const hasSession = sessions.has(chatId);
    await sendCard(
      client,
      chatId,
      'Claude Code',
      hasSession ? '📍 当前有活跃会话' : '💤 无活跃会话',
    );
    return;
  }

  // 调用 Claude
  console.log(`[Claude] 开始处理...`);
  processing.add(chatId);
  const sessionId = sessions.get(chatId) || null;
  const chunks: string[] = [];

  // 创建飞书工具服务器（每次请求创建，绑定当前 chatId）
  const feishuToolsServer = createFeishuToolsServer(client, chatId);

  // 先发送一条"处理中"的消息，获取 message_id
  const messageId = await sendCard(client, chatId, 'Claude Code', '🔄 处理中...');
  if (!messageId) {
    processing.delete(chatId);
    return;
  }

  try {
    for await (const event of streamClaudeChat(text, sessionId, {
      mcpServers: { 'feishu-tools': feishuToolsServer },
    })) {
      switch (event.type) {
        case 'tool_start':
          console.log(`[Claude] 工具调用: ${event.toolName}`);
          chunks.push(formatToolStart(event.toolName!));
          // 实时更新卡片
          await updateCard(client, messageId, 'Claude Code', chunks.join('\n') + '\n\n🔄 执行中...');
          break;
        case 'tool_end':
          console.log(`[Claude] 工具输入: ${event.toolInput?.slice(0, 100)}...`);
          chunks.push(formatToolEnd(event.toolName!, event.toolInput || ''));
          await updateCard(client, messageId, 'Claude Code', chunks.join('\n') + '\n\n🔄 等待结果...');
          break;
        case 'tool_result':
          console.log(`[Claude] 工具结果: ${event.toolOutput?.slice(0, 100)}...`);
          if (event.toolOutput) {
            chunks.push(formatToolResult(event.toolOutput));
          }
          chunks.push('---');
          await updateCard(client, messageId, 'Claude Code', chunks.join('\n') + '\n\n🔄 继续处理...');
          break;
        case 'result':
          console.log(`[Claude] 处理完成`);
          if (event.sessionId) {
            sessions.set(chatId, event.sessionId);
          }
          if (event.content) {
            chunks.push('\n' + event.content);
          }
          break;
        case 'error':
          console.log(`[Claude] 错误: ${event.content}`);
          chunks.push(`\n❌ **错误：** ${event.content}`);
          break;
      }
    }

    // 最终更新为完整结果
    const finalContent = chunks.join('\n') || '（无响应）';
    console.log(`[飞书] 更新最终结果，长度: ${finalContent.length}`);
    await updateCard(client, messageId, 'Claude Code', finalContent);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[错误] Claude 处理失败: ${errMsg}`);
    await updateCard(client, messageId, 'Claude Code', `❌ 错误: ${errMsg}`);
  } finally {
    processing.delete(chatId);
  }
}

async function sendCard(client: Lark.Client, chatId: string, title: string, content: string): Promise<string | null> {
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: buildFeishuCard(title, content),
      },
    });
    const messageId = resp.data?.message_id;
    console.log(`[飞书] 消息发送成功, message_id: ${messageId}`);
    return messageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 消息发送失败: ${errMsg}`);
    return null;
  }
}

async function updateCard(client: Lark.Client, messageId: string, title: string, content: string) {
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildFeishuCard(title, content),
      },
    });
    console.log(`[飞书] 卡片更新成功`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 卡片更新失败: ${errMsg}`);
  }
}
