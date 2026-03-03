import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { streamChat, getProviderName } from './provider.js';
import { formatToolStart, formatToolEnd, formatToolResult, buildFeishuCard } from './formatter.js';
import { MessageDedup } from './dedup.js';
import { InputImage, UsageInfo } from './types.js';

interface LarkErrorLike {
  message?: string;
  response?: {
    status?: number;
    data?: {
      code?: number;
      msg?: string;
      error?: {
        log_id?: string;
      };
    };
  };
}

function formatLarkLog(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;

      const err = arg as LarkErrorLike;
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.msg || err?.message;
      const logId = err?.response?.data?.error?.log_id;

      if (status || code || msg) {
        return `${status ? `HTTP ${status} - ` : ''}${msg || '飞书请求失败'}${code !== undefined ? ` (code: ${code})` : ''}${logId ? ` | log_id: ${logId}` : ''}`;
      }

      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' | ');
}

const larkLogger = {
  error: (...msg: unknown[]) => console.error(`[LarkSDK] ${formatLarkLog(msg)}`),
  warn: (...msg: unknown[]) => console.warn(`[LarkSDK] ${formatLarkLog(msg)}`),
  info: (...msg: unknown[]) => console.log(`[LarkSDK] ${formatLarkLog(msg)}`),
  debug: (...msg: unknown[]) => console.log(`[LarkSDK] ${formatLarkLog(msg)}`),
  trace: (...msg: unknown[]) => console.log(`[LarkSDK] ${formatLarkLog(msg)}`),
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(PROJECT_ROOT, 'log');
const FEISHU_RUNTIME_LOG_PATH = path.join(LOG_DIR, 'feishu-runtime.log');
const INSTANCE_TAG = process.env.INSTANCE_TAG || `${os.hostname()}:${process.pid}`;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFeishuRuntime(eventType: string, data: unknown): void {
  const now = new Date();
  const timestamp = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const line = `[${timestamp}] [${eventType}] ${payload}\n`;

  try {
    fs.appendFileSync(FEISHU_RUNTIME_LOG_PATH, line);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书运行日志] 写入失败 (${FEISHU_RUNTIME_LOG_PATH}): ${errMsg}`);
  }
}

const sessions = new Map<string, string>(); // chatId -> claudeSessionId
const openIdToChatId = new Map<string, string>(); // openId -> chatId（私聊映射，供菜单事件使用）
const dedup = new MessageDedup();
// 跟踪正在处理中的聊天，避免并发
const processing = new Set<string>();
// 每个聊天保留一条待处理消息（只保留最新）
const pendingMessages = new Map<string, any>(); // chatId -> eventData
// 每个聊天保留一张「等待中」卡片，轮到处理时复用该卡片
const queuedCardMessageIds = new Map<string, string>(); // chatId -> messageId
// 跟踪每个聊天的中断控制器，用于 stop 命令
const abortControllers = new Map<string, AbortController>();
// 记录中断原因（用户停止 / 超时）
const abortReasons = new Map<string, 'user' | 'timeout'>(); // chatId -> reason
// 存储卡片消息对应的原始文本（用于「复制原文」按钮回调）
const cardRawContent = new Map<string, string>(); // messageId -> rawContent

// 模块级 client，供启动通知使用
let feishuClient: Lark.Client | null = null;
// 机器人自身的 open_id，用于群聊中判断是否 @了自己
let botOpenId: string | null = null;

// WebSocket 定时刷新连接，防止被网络设备静默丢弃
let wsClientRef: Lark.WSClient | null = null;
let eventDispatcherRef: Lark.EventDispatcher | null = null;
const WS_REFRESH_INTERVAL = 30 * 60 * 1000; // 每 30 分钟刷新一次连接
const senderNameCache = new Map<string, string>(); // openId -> 发送者姓名
const DEFAULT_CHAT_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
const MAX_REPLY_TEXT_LENGTH = 6000;

interface DownloadedImageInput {
  filePath: string;
  mimeType?: string;
  tempDir: string;
}

function getChatTurnTimeoutMs(): number {
  const raw = Number(process.env.CHAT_TURN_TIMEOUT_MS || DEFAULT_CHAT_TURN_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHAT_TURN_TIMEOUT_MS;
  return Math.max(10_000, Math.floor(raw)); // 最小 10 秒
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function getSingleHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function getImageExtension(mimeType?: string): string {
  if (!mimeType) return '.jpg';
  return IMAGE_EXT_BY_MIME[mimeType] || '.jpg';
}

async function downloadImageFromMessage(
  client: Lark.Client,
  messageId: string,
  imageKey: string,
): Promise<DownloadedImageInput> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-image-'));

  try {
    const resource = await client.im.messageResource.get({
      params: { type: 'image' },
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
    });

    const contentTypeHeader = getSingleHeaderValue(resource.headers?.['content-type']);
    const mimeType = contentTypeHeader?.split(';')[0].trim().toLowerCase();
    const extension = getImageExtension(mimeType);
    const filePath = path.join(tempDir, `input${extension}`);

    await resource.writeFile(filePath);

    return {
      filePath,
      mimeType,
      tempDir,
    };
  } catch (error) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

function cleanupDownloadedImages(images: DownloadedImageInput[]): void {
  for (const image of images) {
    try {
      fs.rmSync(image.tempDir, { recursive: true, force: true });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      console.warn(`[消息输入] 清理图片临时目录失败: ${image.tempDir} | ${errMsg}`);
    }
  }
}

async function resolveSenderName(client: Lark.Client, openId?: string): Promise<string | undefined> {
  if (!openId || openId === 'unknown') return undefined;

  const cachedName = senderNameCache.get(openId);
  if (cachedName) return cachedName;

  try {
    const resp = await client.request({
      method: 'GET',
      url: `/open-apis/contact/v3/users/${openId}`,
      params: { user_id_type: 'open_id' },
    }) as any;

    const name = resp?.data?.user?.name as string | undefined;
    if (name) {
      senderNameCache.set(openId, name);
      return name;
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.log(`[消息上下文] 获取发送者姓名失败: ${openId} | ${errMsg}`);
  }

  return undefined;
}

function startPeriodicRefresh() {
  setInterval(() => {
    console.log(`[WS刷新] 定时刷新连接...`);
    refreshWsClient();
  }, WS_REFRESH_INTERVAL);
  console.log(`[WS刷新] 已启动，每 ${WS_REFRESH_INTERVAL / 60000} 分钟刷新一次连接`);
}

function refreshWsClient() {
  if (!wsClientRef || !eventDispatcherRef) return;
  try {
    wsClientRef.close({ force: true });
  } catch (e) {
    console.error('[WS刷新] 关闭旧连接失败:', e);
  }
  wsClientRef = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.error,
    logger: larkLogger,
  });
  wsClientRef.start({ eventDispatcher: eventDispatcherRef });
  console.log('[WS刷新] 新连接已建立');
}

function isReplyOutputMode(): boolean {
  return config.feishuOutputMode === 'reply';
}

function trimReplyText(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '（空内容）';
  if (normalized.length <= MAX_REPLY_TEXT_LENGTH) return normalized;
  const remain = normalized.length - MAX_REPLY_TEXT_LENGTH;
  return `${normalized.slice(0, MAX_REPLY_TEXT_LENGTH)}\n...(已截断 ${remain} 字符)`;
}

function formatReplyText(content: string): string {
  // 保留原有内容语义，只去掉卡片专用 markdown 装饰。
  const normalized = content
    .replace(/\*\*/g, '')
    .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
    .replace(/```/g, '')
    .trim();

  if (!normalized) return '';
  return trimReplyText(normalized);
}

async function sendTextMessage(
  client: Lark.Client,
  receiveIdType: 'chat_id' | 'open_id',
  receiveId: string,
  content: string,
): Promise<string | null> {
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: trimReplyText(content) }),
      },
    });
    const messageId = resp.data?.message_id;
    console.log(`[飞书] 文本消息发送成功, message_id: ${messageId}`);
    return messageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 文本消息发送失败: ${errMsg}`);
    return null;
  }
}

async function sendReplyText(client: Lark.Client, messageId: string, content: string): Promise<string | null> {
  try {
    const resp = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: trimReplyText(content) }),
        reply_in_thread: false,
      },
    });
    const replyMessageId = resp.data?.message_id;
    console.log(`[飞书] 回复消息发送成功, message_id: ${replyMessageId}`);
    return replyMessageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 回复消息发送失败: ${errMsg}`);
    return null;
  }
}

async function addAckReaction(client: Lark.Client, messageId: string): Promise<void> {
  if (!config.feishuReplyAckReaction) return;

  try {
    await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: config.feishuReplyAckEmoji },
      },
    });
    console.log(`[飞书] 已添加消息 reaction: ${config.feishuReplyAckEmoji} | message_id: ${messageId}`);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.warn(`[飞书] 添加消息 reaction 失败: ${errMsg}`);
  }
}

async function sendResponseForIncoming(
  client: Lark.Client,
  chatId: string,
  incomingMessageId: string,
  title: string,
  content: string,
): Promise<string | null> {
  if (isReplyOutputMode()) {
    return sendReplyText(client, incomingMessageId, content);
  }
  return sendCard(client, chatId, title, content);
}

export function startFeishuBot() {
  console.log(`[飞书运行日志] 路径: ${FEISHU_RUNTIME_LOG_PATH}`);
  console.log(`[实例] ${INSTANCE_TAG}`);
  logFeishuRuntime('service.boot', {
    instance: INSTANCE_TAG,
    pid: process.pid,
    cwd: process.cwd(),
    aiProvider: config.aiProvider,
    workspace: config.workspace,
    chatTurnTimeoutMs: getChatTurnTimeoutMs(),
    feishuOutputMode: config.feishuOutputMode,
    replyOptions: {
      showToolCalls: config.feishuReplyShowToolCalls,
      showToolInput: config.feishuReplyShowToolInput,
      showToolResult: config.feishuReplyShowToolResult,
      showUsage: config.feishuReplyShowUsage,
      showQueueNotice: config.feishuReplyShowQueueNotice,
      ackReaction: config.feishuReplyAckReaction,
      ackEmoji: config.feishuReplyAckEmoji,
    },
    feishuAppIdSuffix: config.feishuAppId ? config.feishuAppId.slice(-6) : '',
  });

  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.error,
    logger: larkLogger,
  });
  feishuClient = client;

  const wsClient = new Lark.WSClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.error,
    logger: larkLogger,
  });
  wsClientRef = wsClient;

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
        const message = data.message;
        if (!message) return;

        logFeishuRuntime('event.receive', {
          instance: INSTANCE_TAG,
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType: message.chat_type,
          messageType: message.message_type,
          senderOpenId: data.sender?.sender_id?.open_id || 'unknown',
        });

        // 1. 消息去重
        if (dedup.isDuplicate(message.message_id)) {
          console.log(`[跳过] 重复消息: ${message.message_id}`);
          logFeishuRuntime('event.skip.duplicate', { messageId: message.message_id });
          return;
        }

        // 2. 只处理文本、富文本和图片消息
        if (message.message_type !== 'text' && message.message_type !== 'post' && message.message_type !== 'image') {
          console.log(`[跳过] 非文本消息: ${message.message_type}`);
          logFeishuRuntime('event.skip.message_type', {
            messageId: message.message_id,
            messageType: message.message_type,
          });
          return;
        }

        // 3. 群聊中只响应 @自己的消息
        const chatType = message.chat_type;
        if (chatType === 'group') {
          const mentions = data.message?.mentions;
          const isMentioned = botOpenId
            ? mentions?.some((m: any) => m.id?.open_id === botOpenId)
            : mentions && mentions.length > 0; // fallback: 未获取到 botOpenId 时保持原逻辑
          if (!isMentioned) {
            logFeishuRuntime('event.skip.group_not_mentioned', {
              messageId: message.message_id,
              chatId: message.chat_id,
            });
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

  eventDispatcherRef = eventDispatcher;
  wsClient.start({ eventDispatcher });

  // 启动定时刷新连接
  startPeriodicRefresh();

  // 获取机器人自身的 open_id
  client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' }).then((resp: any) => {
    botOpenId = resp?.bot?.open_id || null;
    console.log(`[初始化] 机器人 open_id: ${botOpenId}`);
  }).catch((err: any) => {
    console.error('[初始化] 获取机器人信息失败:', err);
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
    if (isReplyOutputMode()) {
      await sendTextMessage(client, isOpenId ? 'open_id' : 'chat_id', userId, `✅ 机器人已启动\n工作目录: ${config.workspace}`);
      console.log(`[启动通知] 发送成功`);
      return;
    }

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
        abortReasons.set(chatId, 'user');
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

  if (isReplyOutputMode()) {
    return sendTextMessage(client, receiveIdType, receiveId, `${title}\n${content}`);
  }

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
  const incomingMessageId = message.message_id;
  const useReplyMode = isReplyOutputMode();

  logFeishuRuntime('message.handle.start', {
    instance: INSTANCE_TAG,
    messageId: incomingMessageId,
    chatId,
    aiProvider: config.aiProvider,
    outputMode: config.feishuOutputMode,
  });

  if (useReplyMode) {
    await addAckReaction(client, incomingMessageId);
  }

  // 防止同一个聊天并发处理
  if (processing.has(chatId)) {
    console.log(`[跳过] 聊天 ${chatId} 正在处理中`);
    pendingMessages.set(chatId, data);
    let queuedCardMessageId: string | null = null;

    if (useReplyMode) {
      if (config.feishuReplyShowQueueNotice) {
        await sendReplyText(client, incomingMessageId, '⏳ 当前会话仍在处理中，已收到你的新消息，会在当前任务完成后自动执行。');
      }
    } else {
      const waitContent = '⏳ 上一条消息还在处理中，请稍候...\n\n✅ 已收到你的最新消息，会在当前任务完成后自动处理。';
      queuedCardMessageId = queuedCardMessageIds.get(chatId) || null;

      if (queuedCardMessageId) {
        await updateCard(client, queuedCardMessageId, 'Claude Code', waitContent);
      } else {
        const waitCardMessageId = await sendCard(client, chatId, 'Claude Code', waitContent);
        if (waitCardMessageId) {
          queuedCardMessageIds.set(chatId, waitCardMessageId);
          queuedCardMessageId = waitCardMessageId;
        }
      }
    }

    logFeishuRuntime('message.handle.skip.processing', {
      messageId: incomingMessageId,
      chatId,
      queued: true,
      queuedCardMessageId,
    });
    return;
  }

  // 获取消息文本 / 图片输入
  let text = '';
  const inputImages: InputImage[] = [];
  const downloadedImageInputs: DownloadedImageInput[] = [];
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
    } else if (message.message_type === 'image') {
      const imageKey = parsed.image_key;
      if (!imageKey || typeof imageKey !== 'string') {
        logFeishuRuntime('message.handle.skip.image_key_missing', {
          messageId: incomingMessageId,
          chatId,
          content: message.content,
        });
        return;
      }

      const downloaded = await downloadImageFromMessage(client, incomingMessageId, imageKey);
      downloadedImageInputs.push(downloaded);
      inputImages.push({
        filePath: downloaded.filePath,
        mimeType: downloaded.mimeType,
      });

      text = '请分析用户发送的图片内容，并给出简洁结论。';
      console.log(`[消息输入] 已下载图片: ${downloaded.filePath}`);
    } else {
      text = parsed.text?.trim() || '';
    }
  } catch (error: unknown) {
    if (downloadedImageInputs.length > 0) {
      cleanupDownloadedImages(downloadedImageInputs);
    }
    const errMsg = error instanceof Error ? error.message : '未知错误';
    logFeishuRuntime('message.handle.skip.parse_failed', {
      messageId: incomingMessageId,
      chatId,
      error: errMsg,
    });

    if (message.message_type === 'image') {
      await sendResponseForIncoming(client, chatId, incomingMessageId, 'Claude Code', `❌ 图片读取失败：${errMsg}`);
    }

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

  if (!text && inputImages.length === 0) {
    logFeishuRuntime('message.handle.skip.empty_text', {
      messageId: incomingMessageId,
      chatId,
    });
    return;
  }

  console.log(`[消息内容] "${text}"`);

  // 处理命令
  if (text === '/clear' || text === '/new') {
    console.log(`[命令] 清除会话`);
    sessions.delete(chatId);
    await sendResponseForIncoming(client, chatId, incomingMessageId, 'Claude Code', '✅ 会话已清除，开始新对话');
    return;
  }

  if (text === '/stop') {
    console.log(`[命令] 停止处理`);
    if (abortControllers.has(chatId)) {
      abortReasons.set(chatId, 'user');
      abortControllers.get(chatId)!.abort();
      await sendResponseForIncoming(client, chatId, incomingMessageId, 'Claude Code', '⏹️ 已停止当前处理');
    } else {
      await sendResponseForIncoming(client, chatId, incomingMessageId, 'Claude Code', '💤 当前没有正在处理的任务');
    }
    return;
  }

  if (text === '/status') {
    console.log(`[命令] 查询状态`);
    const hasSession = sessions.has(chatId);
    await sendResponseForIncoming(
      client,
      chatId,
      incomingMessageId,
      'Claude Code',
      hasSession ? '📍 当前有活跃会话' : '💤 无活跃会话',
    );
    return;
  }

  // 调用 AI
  const senderOpenId = data.sender?.sender_id?.open_id;
  const senderName = await resolveSenderName(client, senderOpenId);
  if (senderName && senderOpenId) {
    console.log(`[消息上下文] 当前发送者: ${senderName} (${senderOpenId})`);
  } else if (senderOpenId) {
    console.log(`[消息上下文] 当前发送者 open_id: ${senderOpenId}`);
  }

  const providerName = getProviderName();
  console.log(`[${providerName}] 开始处理...`);
  processing.add(chatId);
  const abortController = new AbortController();
  abortControllers.set(chatId, abortController);
  abortReasons.delete(chatId);
  const sessionId = sessions.get(chatId) || null;
  const chunks: string[] = [];
  let resultContent = ''; // AI 回复的纯文本，用于复制按钮
  let usageInfo: UsageInfo | undefined;
  let finalStatusMessage: string | null = null;
  const chatTurnTimeoutMs = getChatTurnTimeoutMs();
  const chatTurnTimeoutSec = Math.ceil(chatTurnTimeoutMs / 1000);

  let messageId: string | null = null;
  if (!useReplyMode) {
    // 优先复用「等待中」卡片，避免同一条用户消息出现两张卡片
    messageId = queuedCardMessageIds.get(chatId) || null;
    if (messageId) {
      queuedCardMessageIds.delete(chatId);
      await updateCard(client, messageId, providerName, '🔄 处理中...');
    } else {
      // 先发送一条"处理中"的消息，获取 message_id
      messageId = await sendCard(client, chatId, providerName, '🔄 处理中...');
    }

    if (!messageId) {
      processing.delete(chatId);
      abortControllers.delete(chatId);
      abortReasons.delete(chatId);
      cleanupDownloadedImages(downloadedImageInputs);
      return;
    }
  }

  let timeoutTimer: NodeJS.Timeout | null = null;
  const resetTurnTimeout = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    timeoutTimer = setTimeout(() => {
      if (!abortController.signal.aborted) {
        abortReasons.set(chatId, 'timeout');
        abortController.abort();
        logFeishuRuntime('message.handle.timeout.abort', {
          chatId,
          messageId: incomingMessageId,
          timeoutMs: chatTurnTimeoutMs,
        });
      }
    }, chatTurnTimeoutMs);
  };

  resetTurnTimeout();

  try {
    const stream = streamChat(text, sessionId, {
      abortSignal: abortController.signal,
      feishuClient: client,
      chatId,
      senderOpenId,
      senderName,
      inputImages,
    });

    for await (const event of stream) {
      // 模型文本回复、工具事件都算进度，刷新超时计时避免长任务被误判超时
      const shouldRefreshTimeout = event.type === 'text'
        || event.type === 'result'
        || event.type === 'tool_start'
        || event.type === 'tool_end'
        || event.type === 'tool_result';
      if (shouldRefreshTimeout) {
        resetTurnTimeout();
      }

      if (abortController.signal.aborted) {
        const reason = abortReasons.get(chatId);
        if (reason === 'timeout') {
          console.log(`[${providerName}] 超时中断处理`);
          finalStatusMessage = `⏱️ 执行超时（>${chatTurnTimeoutSec}s），已自动停止。`;
          if (!useReplyMode) {
            chunks.push(`\n⏱️ **执行超时（>${chatTurnTimeoutSec}s），已自动停止**`);
          }
        } else {
          console.log(`[${providerName}] 用户中断处理`);
          finalStatusMessage = '⏹️ 已被用户停止';
          if (!useReplyMode) {
            chunks.push('\n⏹️ **已被用户停止**');
          }
        }
        break;
      }

      switch (event.type) {
        case 'tool_start':
          console.log(`[${providerName}] 工具调用: ${event.toolName}`);
          if (useReplyMode) {
            if (config.feishuReplyShowToolCalls) {
              const rawToolStart = formatToolStart(event.toolName || '工具');
              const toolStartText = formatReplyText(rawToolStart);
              if (toolStartText) {
                await sendReplyText(client, incomingMessageId, toolStartText);
              }
            }
          } else {
            chunks.push(formatToolStart(event.toolName!));
            // 实时更新卡片
            await updateCard(client, messageId!, providerName, chunks.join('\n') + '\n\n🔄 执行中...');
          }
          break;
        case 'tool_end':
          console.log(`[${providerName}] 工具输入: ${event.toolInput?.slice(0, 100)}...`);
          if (useReplyMode) {
            if (config.feishuReplyShowToolInput) {
              const toolName = event.toolName || '工具';
              const toolEndText = formatReplyText(formatToolEnd(toolName, event.toolInput || ''));
              if (toolEndText) {
                await sendReplyText(client, incomingMessageId, `📥 ${toolName} 输入\n${toolEndText}`);
              }
            }
          } else {
            chunks.push(formatToolEnd(event.toolName!, event.toolInput || ''));
            await updateCard(client, messageId!, providerName, chunks.join('\n') + '\n\n🔄 等待结果...');
          }
          break;
        case 'tool_result':
          console.log(`[${providerName}] 工具结果: ${event.toolOutput?.slice(0, 100)}...`);
          if (useReplyMode) {
            if (config.feishuReplyShowToolResult && event.toolOutput) {
              const toolResultText = formatReplyText(formatToolResult(event.toolOutput));
              if (toolResultText) {
                await sendReplyText(client, incomingMessageId, `📤 工具结果\n${toolResultText}`);
              }
            }
          } else {
            if (event.toolOutput) {
              chunks.push(formatToolResult(event.toolOutput));
            }
            chunks.push('---');
            await updateCard(client, messageId!, providerName, chunks.join('\n') + '\n\n🔄 继续处理...');
          }
          break;
        case 'text':
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
          finalStatusMessage = `❌ 错误：${event.content || '未知错误'}`;
          if (!useReplyMode) {
            chunks.push(`\n❌ **错误：** ${event.content}`);
          }
          break;
      }
    }

    if (useReplyMode) {
      let finalReplyText = resultContent.trim();
      if (!finalReplyText) {
        finalReplyText = finalStatusMessage || '（无响应）';
      }
      if (usageInfo && config.feishuReplyShowUsage) {
        finalReplyText += formatUsageInfo(usageInfo);
      }
      await sendReplyText(client, incomingMessageId, finalReplyText);
    } else {
      // 最终更新为完整结果
      let finalContent = chunks.join('\n') || '（无响应）';
      if (usageInfo) {
        finalContent += formatUsageInfo(usageInfo);
      }
      console.log(`[飞书] 更新最终结果，长度: ${finalContent.length}`);
      await updateCard(client, messageId!, providerName, finalContent, resultContent || undefined);
      // 存储原始内容，供「复制原文」回调使用
      if (resultContent) {
        cardRawContent.set(messageId!, resultContent);
      }
    }

    logFeishuRuntime('message.handle.done', {
      instance: INSTANCE_TAG,
      messageId: incomingMessageId,
      chatId,
      responseMessageId: useReplyMode ? incomingMessageId : messageId,
      hasResult: Boolean(resultContent),
      chunkCount: chunks.length,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    const abortReason = abortReasons.get(chatId);
    const timeoutErrMsg = `执行超时（>${chatTurnTimeoutSec}s），已自动停止。你可以直接重试，或发送 /status 查看当前状态。`;
    const finalErrMsg = abortReason === 'timeout' ? timeoutErrMsg : errMsg;
    console.error(`[错误] Claude 处理失败: ${errMsg}`);
    logFeishuRuntime('message.handle.error', {
      instance: INSTANCE_TAG,
      messageId: incomingMessageId,
      chatId,
      error: finalErrMsg,
      rawError: errMsg,
      abortReason: abortReason || null,
    });

    if (useReplyMode) {
      await sendReplyText(client, incomingMessageId, `❌ 错误: ${finalErrMsg}`);
    } else if (messageId) {
      await updateCard(client, messageId, providerName, `❌ 错误: ${finalErrMsg}`);
    }
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    processing.delete(chatId);
    abortControllers.delete(chatId);
    abortReasons.delete(chatId);

    const pending = pendingMessages.get(chatId);
    if (pending) {
      pendingMessages.delete(chatId);
      logFeishuRuntime('message.handle.dequeue', {
        chatId,
        messageId: pending?.message?.message_id,
      });
      setImmediate(() => {
        handleMessage(client, pending).catch((err) => {
          console.error('[错误] 处理排队消息失败:', err);
        });
      });
    }

    if (downloadedImageInputs.length > 0) {
      cleanupDownloadedImages(downloadedImageInputs);
    }
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
