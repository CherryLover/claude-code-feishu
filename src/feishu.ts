import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config';
import { streamClaudeChat } from './claude';
import { formatToolStart, formatToolEnd, formatToolResult, buildFeishuCard } from './formatter';
import { MessageDedup } from './dedup';

const sessions = new Map<string, string>(); // chatId -> claudeSessionId
const dedup = new MessageDedup();
// 跟踪正在处理中的聊天，避免并发
const processing = new Set<string>();

export function startFeishuBot() {
  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });

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
          return;
        }

        // 2. 只处理文本消息
        if (message.message_type !== 'text') {
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

        // 4. 异步处理（立即返回，避免 3 秒超时）
        setImmediate(() => {
          handleMessage(client, data).catch((err) => {
            console.error('处理消息失败:', err);
          });
        });
      },
    }),
  });

  console.log('飞书机器人已启动（WebSocket 长连接）');
}

async function handleMessage(client: Lark.Client, data: any) {
  const message = data.message;
  const chatId = message.chat_id;

  // 防止同一个聊天并发处理
  if (processing.has(chatId)) {
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

  // 处理命令
  if (text === '/clear' || text === '/new') {
    sessions.delete(chatId);
    await sendCard(client, chatId, 'Claude Code', '✅ 会话已清除，开始新对话');
    return;
  }

  if (text === '/status') {
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
  processing.add(chatId);
  const sessionId = sessions.get(chatId) || null;
  const chunks: string[] = [];

  try {
    for await (const event of streamClaudeChat(text, sessionId)) {
      switch (event.type) {
        case 'tool_start':
          chunks.push(formatToolStart(event.toolName!));
          break;
        case 'tool_end':
          chunks.push(formatToolEnd(event.toolName!, event.toolInput || ''));
          break;
        case 'tool_result':
          if (event.toolOutput) {
            chunks.push(formatToolResult(event.toolOutput));
          }
          chunks.push('---');
          break;
        case 'result':
          if (event.sessionId) {
            sessions.set(chatId, event.sessionId);
          }
          if (event.content) {
            chunks.push('\n' + event.content);
          }
          break;
        case 'error':
          chunks.push(`\n❌ **错误：** ${event.content}`);
          break;
      }
    }

    const finalContent = chunks.join('\n') || '（无响应）';
    await sendCard(client, chatId, 'Claude Code', finalContent);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    await sendCard(client, chatId, 'Claude Code', `❌ 错误: ${errMsg}`);
  } finally {
    processing.delete(chatId);
  }
}

async function sendCard(client: Lark.Client, chatId: string, title: string, content: string) {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: buildFeishuCard(title, content),
      },
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error('发送飞书消息失败:', errMsg);
  }
}
