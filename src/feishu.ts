import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config';
import { streamChat, getProviderName } from './provider';
import { formatToolStart, formatToolEnd, formatToolResult, buildFeishuCard } from './formatter';
import { MessageDedup } from './dedup';
import { UsageInfo } from './types';

const sessions = new Map<string, string>(); // chatId -> claudeSessionId
const openIdToChatId = new Map<string, string>(); // openId -> chatId（私聊映射，供菜单事件使用）
const dedup = new MessageDedup();
// 跟踪正在处理中的聊天，避免并发
const processing = new Set<string>();
// 跟踪每个聊天的中断控制器，用于 stop 命令
const abortControllers = new Map<string, AbortController>();
// 存储卡片消息对应的原始文本（用于「复制原文」按钮回调）
const cardRawContent = new Map<string, string>(); // messageId -> rawContent

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

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
        const message = data.message;
        if (!message) return;

        // 1. 消息去重
        if (dedup.isDuplicate(message.message_id)) {
          console.log(`[跳过] 重复消息: ${message.message_id}`);
          return;
        }

        // 2. 只处理文本和富文本消息
        if (message.message_type !== 'text' && message.message_type !== 'post') {
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
        // 私聊时记录 openId -> chatId 映射，供菜单事件使用
        if (chatType === 'p2p' && senderId !== 'unknown') {
          openIdToChatId.set(senderId, message.chat_id);
        }
        console.log(`[收到消息] ${chatType === 'group' ? '群聊' : '私聊'} | chat_id: ${message.chat_id} | sender: ${senderId}`);

        // 4. 异步处理（立即返回，避免 3 秒超时）
        setImmediate(() => {
          handleMessage(client, data).catch((err) => {
            console.error('[错误] 处理消息失败:', err);
          });
        });
      },
      'application.bot.menu_v6': async (data: any) => {
        const eventKey = data.event_key;
        const openId = data.operator?.operator_id?.open_id;
        if (!openId) return;

        console.log(`[菜单] event_key: ${eventKey} | open_id: ${openId}`);

        setImmediate(() => {
          handleMenuEvent(client, eventKey, openId).catch((err) => {
            console.error('[错误] 处理菜单事件失败:', err);
          });
        });
      },
    'card.action.trigger': async (data: any) => {
      const action = data?.action;
      const value = action?.value;
      if (value?.action === 'copy_raw') {
        const messageId = data?.context?.open_message_id;
        const openId = data?.operator?.open_id;
        const rawContent = messageId ? cardRawContent.get(messageId) : undefined;

        console.log(`[卡片回调] 复制原文 | message_id: ${messageId} | open_id: ${openId}`);

        if (rawContent && openId) {
          // 发送纯文本消息，方便用户复制
          try {
            await client.im.message.create({
              params: { receive_id_type: 'open_id' },
              data: {
                receive_id: openId,
                msg_type: 'text',
                content: JSON.stringify({ text: rawContent }),
              },
            });
          } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : '未知错误';
            console.error(`[卡片回调] 发送纯文本失败: ${errMsg}`);
          }
        }

        return {
          toast: {
            type: rawContent ? 'success' : 'info',
            content: rawContent ? '已发送纯文本消息，可长按复制' : '原文内容已过期',
          },
        };
      }
    },
  });

  wsClient.start({ eventDispatcher });

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

async function handleMenuEvent(client: Lark.Client, eventKey: string, openId: string) {
  const chatId = openIdToChatId.get(openId);

  switch (eventKey) {
    case '/clear':
    case 'clear': {
      console.log(`[菜单] 清除会话`);
      if (chatId) {
        sessions.delete(chatId);
      }
      await sendCardToUser(client, openId, chatId, 'Claude Code', '✅ 会话已清除，开始新对话');
      break;
    }
    case '/stop':
    case 'stop': {
      console.log(`[菜单] 停止处理`);
      if (chatId && abortControllers.has(chatId)) {
        abortControllers.get(chatId)!.abort();
        await sendCardToUser(client, openId, chatId, 'Claude Code', '⏹️ 已停止当前处理');
      } else {
        await sendCardToUser(client, openId, chatId, 'Claude Code', '💤 当前没有正在处理的任务');
      }
      break;
    }
    case '/status':
    case 'status': {
      console.log(`[菜单] 查询状态`);
      const hasSession = chatId ? sessions.has(chatId) : false;
      await sendCardToUser(
        client,
        openId,
        chatId,
        'Claude Code',
        hasSession ? '📍 当前有活跃会话' : '💤 无活跃会话',
      );
      break;
    }
    default:
      console.log(`[菜单] 未知 event_key: ${eventKey}`);
  }
}

// 发送卡片给用户，优先用 chat_id，没有则用 open_id
async function sendCardToUser(
  client: Lark.Client,
  openId: string,
  chatId: string | undefined,
  title: string,
  content: string,
): Promise<string | null> {
  const receiveIdType = chatId ? 'chat_id' : 'open_id';
  const receiveId = chatId || openId;
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: buildFeishuCard(title, content),
      },
    });
    const messageId = resp.data?.message_id;
    console.log(`[飞书] 菜单响应发送成功, message_id: ${messageId}`);
    return messageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 菜单响应发送失败: ${errMsg}`);
    return null;
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
    if (message.message_type === 'post') {
      // 富文本消息：提取所有文本内容
      const post = parsed.zh_cn || parsed.en_us || Object.values(parsed)[0] as any;
      if (post?.content) {
        const parts: string[] = [];
        if (post.title) parts.push(post.title);
        for (const line of post.content) {
          const lineText = line
            .filter((el: any) => el.tag === 'text' || el.tag === 'a')
            .map((el: any) => el.text || '')
            .join('');
          if (lineText) parts.push(lineText);
        }
        text = parts.join('\n').trim();
      }
    } else {
      text = parsed.text?.trim() || '';
    }
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

  if (text === '/stop') {
    console.log(`[命令] 停止处理`);
    if (abortControllers.has(chatId)) {
      abortControllers.get(chatId)!.abort();
      await sendCard(client, chatId, 'Claude Code', '⏹️ 已停止当前处理');
    } else {
      await sendCard(client, chatId, 'Claude Code', '💤 当前没有正在处理的任务');
    }
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

  // 调用 AI
  const providerName = getProviderName();
  console.log(`[${providerName}] 开始处理...`);
  processing.add(chatId);
  const abortController = new AbortController();
  abortControllers.set(chatId, abortController);
  const sessionId = sessions.get(chatId) || null;
  const chunks: string[] = [];
  let resultContent = ''; // AI 回复的纯文本，用于复制按钮
  let usageInfo: UsageInfo | undefined;

  // 先发送一条"处理中"的消息，获取 message_id
  const messageId = await sendCard(client, chatId, providerName, '🔄 处理中...');
  if (!messageId) {
    processing.delete(chatId);
    abortControllers.delete(chatId);
    return;
  }

  try {
    const stream = streamChat(text, sessionId, {
      abortSignal: abortController.signal,
      feishuClient: client,
      chatId,
    });

    for await (const event of stream) {
      if (abortController.signal.aborted) {
        console.log(`[${providerName}] 用户中断处理`);
        chunks.push('\n⏹️ **已被用户停止**');
        break;
      }

      switch (event.type) {
        case 'tool_start':
          console.log(`[${providerName}] 工具调用: ${event.toolName}`);
          chunks.push(formatToolStart(event.toolName!));
          // 实时更新卡片
          await updateCard(client, messageId, providerName, chunks.join('\n') + '\n\n🔄 执行中...');
          break;
        case 'tool_end':
          console.log(`[${providerName}] 工具输入: ${event.toolInput?.slice(0, 100)}...`);
          chunks.push(formatToolEnd(event.toolName!, event.toolInput || ''));
          await updateCard(client, messageId, providerName, chunks.join('\n') + '\n\n🔄 等待结果...');
          break;
        case 'tool_result':
          console.log(`[${providerName}] 工具结果: ${event.toolOutput?.slice(0, 100)}...`);
          if (event.toolOutput) {
            chunks.push(formatToolResult(event.toolOutput));
          }
          chunks.push('---');
          await updateCard(client, messageId, providerName, chunks.join('\n') + '\n\n🔄 继续处理...');
          break;
        case 'result':
          console.log(`[${providerName}] 处理完成`);
          if (event.sessionId) {
            sessions.set(chatId, event.sessionId);
          }
          if (event.content) {
            resultContent = event.content;
            chunks.push('\n' + event.content);
          }
          usageInfo = event.usage;
          break;
        case 'error':
          console.log(`[${providerName}] 错误: ${event.content}`);
          chunks.push(`\n❌ **错误：** ${event.content}`);
          break;
      }
    }

    // 最终更新为完整结果
    let finalContent = chunks.join('\n') || '（无响应）';
    if (usageInfo) {
      finalContent += formatUsageInfo(usageInfo);
    }
    console.log(`[飞书] 更新最终结果，长度: ${finalContent.length}`);
    await updateCard(client, messageId, providerName, finalContent, resultContent || undefined);
    // 存储原始内容，供「复制原文」回调使用
    if (resultContent) {
      cardRawContent.set(messageId, resultContent);
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[错误] Claude 处理失败: ${errMsg}`);
    await updateCard(client, messageId, providerName, `❌ 错误: ${errMsg}`);
  } finally {
    processing.delete(chatId);
    abortControllers.delete(chatId);
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

function formatUsageInfo(usage: UsageInfo): string {
  const used = usage.inputTokens + usage.outputTokens;
  const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  if (usage.contextWindow) {
    const remaining = usage.contextWindow - used;
    const percent = ((remaining / usage.contextWindow) * 100).toFixed(0);
    let info = `\n\n---\n📊 上下文: ${formatTokens(used)} / ${formatTokens(usage.contextWindow)} tokens (剩余 ${percent}%)`;
    if (usage.costUSD != null) {
      info += ` | 费用: $${usage.costUSD.toFixed(4)}`;
    }
    return info;
  }

  let info = `\n\n---\n📊 Tokens: ${formatTokens(used)} (输入: ${formatTokens(usage.inputTokens)}, 输出: ${formatTokens(usage.outputTokens)})`;
  if (usage.costUSD != null) {
    info += ` | 费用: $${usage.costUSD.toFixed(4)}`;
  }
  return info;
}

async function updateCard(client: Lark.Client, messageId: string, title: string, content: string, copyContent?: string) {
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildFeishuCard(title, content, copyContent),
      },
    });
    console.log(`[飞书] 卡片更新成功`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 卡片更新失败: ${errMsg}`);
  }
}
