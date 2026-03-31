import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getProviderName } from './provider.js';
import { MessageDedup } from './dedup.js';
import { InputImage } from './types.js';
import {
  addAckReaction,
  formatUsageInfo,
  sendCard,
  sendReplyText,
  sendTextMessage,
  updateCard,
} from './feishu-messages.js';
import { executeTask } from './task-executor.js';
import { createTaskProgressState, renderTaskProgressMarkdown } from './task-progress.js';
import { startSchedulerService } from './scheduler/service.js';

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
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOG_DIR = path.join(PROJECT_ROOT, 'log');
const FEISHU_RUNTIME_LOG_PATH = path.join(LOG_DIR, 'feishu-runtime.log');
const TOPIC_SESSION_CACHE_DIR = path.join(DATA_DIR, 'topic-session-cache');
const TOPIC_SESSION_HISTORY_DIR = path.join(TOPIC_SESSION_CACHE_DIR, 'history');
const TOPIC_SESSION_CACHE_PATH = path.join(TOPIC_SESSION_CACHE_DIR, 'index.json');
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

const sessions = new Map<string, string>(); // sessionKey -> claudeSessionId
const openIdToChatId = new Map<string, string>(); // openId -> chatId（私聊映射，供菜单事件使用）
const dedup = new MessageDedup();
// 跟踪正在处理中的聊天，避免并发（key 为 sessionKey，话题群按话题隔离）
const processing = new Set<string>();
// 每个会话保留一条待处理消息（只保留最新）
const pendingMessages = new Map<string, any>(); // sessionKey -> eventData
// 每个会话保留一张「等待中」卡片，轮到处理时复用该卡片
const queuedCardMessageIds = new Map<string, string>(); // sessionKey -> messageId
// 跟踪每个会话的中断控制器，用于 stop 命令
const abortControllers = new Map<string, AbortController>();
// 记录中断原因（用户停止 / 超时）
const abortReasons = new Map<string, 'user' | 'timeout'>(); // sessionKey -> reason
// 存储卡片消息对应的原始文本（用于「复制原文」按钮回调）
const cardRawContent = new Map<string, string>(); // messageId -> rawContent

/**
 * 构建会话级别的 key：话题群中按 chatId + threadId 隔离，非话题群 / 私聊仅用 chatId
 */
function buildSessionKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

// 机器人自身的 open_id，用于群聊中判断是否 @了自己
let botOpenId: string | null = null;

// WebSocket 定时刷新连接，防止被网络设备静默丢弃
let wsClientRef: Lark.WSClient | null = null;
let eventDispatcherRef: Lark.EventDispatcher | null = null;
const WS_REFRESH_INTERVAL = 30 * 60 * 1000; // 每 30 分钟刷新一次连接
const senderNameCache = new Map<string, string>(); // openId -> 发送者姓名
const DEFAULT_CHAT_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟
const PROJECT_WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
const PRIVATE_WORKSPACE_PREFIX = 'user_';
const SHARED_WORKSPACE_DIR = path.join(PROJECT_WORKSPACE_ROOT, 'shared');
const groupChatMetaCache = new Map<string, GroupChatMeta>();
const GROUP_CHAT_META_TTL_MS = 5 * 60 * 1000;
const GROUP_CHAT_META_ERROR_TTL_MS = 60 * 1000;

interface GroupChatMeta {
  fetchedAt: number;
  expiresAt: number;
  isTopicGroup: boolean;
  isBotUserPairGroup: boolean;
  groupMessageType?: string;
  chatMode?: string;
  userCount?: number;
  botCount?: number;
  fetchError?: string;
}

interface TopicSessionCacheEntry {
  sessionKey: string;
  chatId: string;
  threadId: string;
  sessionId: string | null;
  historyFilePath?: string;
  contextStartTimeMs?: number;
  createdAt: string;
  updatedAt: string;
}

interface TopicSessionCacheFile {
  version: 1;
  updatedAt: string;
  entries: Record<string, TopicSessionCacheEntry>;
}

interface TopicHistoryExportResult {
  filePath: string;
  totalMessages: number;
  exportedMessages: number;
}

interface DownloadedImageInput {
  filePath: string;
  mimeType?: string;
  tempDir: string;
}

const topicSessionCache = new Map<string, TopicSessionCacheEntry>();
let topicSessionCacheLoaded = false;

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

function sanitizeWorkspaceSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

function resolveMessageWorkingDirectory(chatType: string, senderOpenId?: string): string {
  if (chatType === 'p2p' && senderOpenId) {
    if (config.developerOpenId && senderOpenId === config.developerOpenId) {
      return config.developerWorkspace || os.homedir();
    }

    const safeUserId = sanitizeWorkspaceSegment(senderOpenId);
    if (safeUserId) {
      return path.join(PROJECT_WORKSPACE_ROOT, `${PRIVATE_WORKSPACE_PREFIX}${safeUserId}`);
    }
  }

  return SHARED_WORKSPACE_DIR;
}

async function ensureWorkingDirectory(workspacePath: string): Promise<void> {
  await fs.promises.mkdir(workspacePath, { recursive: true });
}

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

function parseCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return undefined;
}

function isMessageMentioningBot(message: any): boolean {
  const mentions = message?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return false;

  if (!botOpenId) return true;
  return mentions.some((mention: any) => mention.id?.open_id === botOpenId);
}

function extractPostBody(parsed: any): { title?: string; content?: any[] } | null {
  if (!parsed || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed.content)) {
    return parsed;
  }

  const localePayload = parsed.zh_cn || parsed.en_us;
  if (localePayload && typeof localePayload === 'object' && Array.isArray(localePayload.content)) {
    return localePayload;
  }

  const firstObjectValue = Object.values(parsed).find((value) => (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as any).content)
  )) as { title?: string; content?: any[] } | undefined;

  return firstObjectValue || null;
}

function extractPostText(parsed: any): string {
  const post = extractPostBody(parsed);
  if (!post?.content) return '';

  const parts: string[] = [];
  if (typeof post.title === 'string' && post.title.trim()) {
    parts.push(post.title.trim());
  }

  for (const line of post.content) {
    if (!Array.isArray(line)) continue;

    const lineText = line
      .filter((el: any) => {
        const tag = typeof el?.tag === 'string' ? el.tag : '';
        return tag === 'text' || tag === 'a' || tag === 'at';
      })
      .map((el: any) => {
        if (typeof el?.text === 'string') return el.text;
        if (typeof el?.name === 'string') return `@${el.name}`;
        return '';
      })
      .join('');

    if (lineText.trim()) {
      parts.push(lineText.trim());
    }
  }

  return parts.join('\n').trim();
}

function ensureTopicSessionCacheDirs(): void {
  fs.mkdirSync(TOPIC_SESSION_HISTORY_DIR, { recursive: true });
}

function normalizeTopicSessionCacheEntry(raw: unknown): TopicSessionCacheEntry | null {
  if (!raw || typeof raw !== 'object') return null;

  const entry = raw as Record<string, unknown>;
  const sessionKey = typeof entry.sessionKey === 'string' ? entry.sessionKey.trim() : '';
  const chatId = typeof entry.chatId === 'string' ? entry.chatId.trim() : '';
  const threadId = typeof entry.threadId === 'string' ? entry.threadId.trim() : '';

  if (!sessionKey || !chatId || !threadId) return null;

  const sessionId = typeof entry.sessionId === 'string' && entry.sessionId.trim()
    ? entry.sessionId.trim()
    : null;
  const historyFilePath = typeof entry.historyFilePath === 'string' && entry.historyFilePath.trim()
    ? entry.historyFilePath.trim()
    : undefined;
  const contextStartTimeMs = parseCount(entry.contextStartTimeMs);
  const createdAt = typeof entry.createdAt === 'string' && entry.createdAt.trim()
    ? entry.createdAt.trim()
    : new Date().toISOString();
  const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
    ? entry.updatedAt.trim()
    : createdAt;

  return {
    sessionKey,
    chatId,
    threadId,
    sessionId,
    historyFilePath,
    contextStartTimeMs,
    createdAt,
    updatedAt,
  };
}

function writeTopicSessionCache(): void {
  ensureTopicSessionCacheDirs();

  const entries = Object.fromEntries(
    Array.from(topicSessionCache.entries())
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => [key, value]),
  );

  const payload: TopicSessionCacheFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  };

  const tempPath = `${TOPIC_SESSION_CACHE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, TOPIC_SESSION_CACHE_PATH);
}

function loadTopicSessionCache(): void {
  if (topicSessionCacheLoaded) return;

  ensureTopicSessionCacheDirs();
  topicSessionCacheLoaded = true;

  if (!fs.existsSync(TOPIC_SESSION_CACHE_PATH)) {
    writeTopicSessionCache();
    logFeishuRuntime('topic.session.cache.load', {
      path: TOPIC_SESSION_CACHE_PATH,
      count: 0,
      restoredSessionCount: 0,
    });
    return;
  }

  try {
    const raw = fs.readFileSync(TOPIC_SESSION_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TopicSessionCacheFile>;
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    let restoredSessionCount = 0;

    for (const [sessionKey, value] of Object.entries(entries)) {
      const entry = normalizeTopicSessionCacheEntry({ ...(value as object), sessionKey });
      if (!entry) continue;

      topicSessionCache.set(entry.sessionKey, entry);
      if (entry.sessionId) {
        sessions.set(entry.sessionKey, entry.sessionId);
        restoredSessionCount += 1;
      }
    }

    logFeishuRuntime('topic.session.cache.load', {
      path: TOPIC_SESSION_CACHE_PATH,
      count: topicSessionCache.size,
      restoredSessionCount,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[Topic会话缓存] 加载失败: ${errMsg}`);
    logFeishuRuntime('topic.session.cache.load_error', {
      path: TOPIC_SESSION_CACHE_PATH,
      error: errMsg,
    });
  }
}

function getTopicSessionCacheEntry(sessionKey: string): TopicSessionCacheEntry | undefined {
  return topicSessionCache.get(sessionKey);
}

function upsertTopicSessionCacheEntry(params: {
  sessionKey: string;
  chatId: string;
  threadId: string;
  sessionId?: string | null;
  historyFilePath?: string | null;
  contextStartTimeMs?: number | null;
}): TopicSessionCacheEntry {
  ensureTopicSessionCacheDirs();

  const now = new Date().toISOString();
  const previous = topicSessionCache.get(params.sessionKey);
  const next: TopicSessionCacheEntry = {
    sessionKey: params.sessionKey,
    chatId: params.chatId,
    threadId: params.threadId,
    sessionId: previous?.sessionId || null,
    historyFilePath: previous?.historyFilePath,
    contextStartTimeMs: previous?.contextStartTimeMs,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };

  if ('sessionId' in params) {
    next.sessionId = params.sessionId || null;
  }

  if ('historyFilePath' in params) {
    if (params.historyFilePath) {
      next.historyFilePath = params.historyFilePath;
    } else {
      delete next.historyFilePath;
    }
  }

  if ('contextStartTimeMs' in params) {
    const timestamp = parseCount(params.contextStartTimeMs);
    if (timestamp !== undefined) {
      next.contextStartTimeMs = timestamp;
    } else {
      delete next.contextStartTimeMs;
    }
  }

  topicSessionCache.set(params.sessionKey, next);

  if ('sessionId' in params) {
    if (next.sessionId) {
      sessions.set(params.sessionKey, next.sessionId);
    } else {
      sessions.delete(params.sessionKey);
    }
  }

  writeTopicSessionCache();
  return next;
}

function formatHistoryTimestamp(timestampMs?: string): string {
  const parsed = parseCount(timestampMs);
  if (parsed === undefined) return '未知时间';

  return new Date(parsed).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function replaceMessageMentions(text: string, mentions?: Array<{ key?: string; name?: string }>): string {
  let nextText = text;

  for (const mention of mentions || []) {
    if (!mention?.key || !mention?.name) continue;
    nextText = nextText.split(mention.key).join(`@${mention.name}`);
  }

  return nextText.trim();
}

function extractHistoryMessageText(item: any): string {
  if (item?.deleted) return '[消息已撤回]';

  const msgType = typeof item?.msg_type === 'string' ? item.msg_type : '';
  const rawContent = typeof item?.body?.content === 'string' ? item.body.content : '';

  if (!rawContent) {
    switch (msgType) {
      case 'image':
        return '[图片消息]';
      case 'interactive':
        return '';
      default:
        return msgType ? `[${msgType} 消息]` : '[未知消息]';
    }
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent.trim();
  }

  switch (msgType) {
    case 'text':
      return replaceMessageMentions(typeof parsed?.text === 'string' ? parsed.text : '', item?.mentions);
    case 'post':
      return extractPostText(parsed);
    case 'image':
      return '[图片消息]';
    case 'interactive':
      return '';
    default:
      if (typeof parsed?.text === 'string') {
        return replaceMessageMentions(parsed.text, item?.mentions);
      }
      return `[${msgType || '未知'} 消息]`;
  }
}

async function resolveHistorySenderLabel(client: Lark.Client, item: any, providerName: string): Promise<string> {
  const sender = item?.sender;
  const senderType = typeof sender?.sender_type === 'string' ? sender.sender_type : '';
  const senderId = typeof sender?.id === 'string' ? sender.id : '';
  const senderIdType = typeof sender?.id_type === 'string' ? sender.id_type : '';

  if (senderType === 'app') {
    return providerName;
  }

  if (senderType === 'anonymous') {
    return '匿名用户';
  }

  if (senderIdType === 'open_id' && senderId) {
    return await resolveSenderName(client, senderId) || senderId;
  }

  return senderId || '未知发送者';
}

async function fetchTopicHistoryMessages(client: Lark.Client, threadId: string): Promise<any[]> {
  const items: any[] = [];
  let pageToken: string | undefined;

  do {
    const resp = await client.im.message.list({
      params: {
        container_id_type: 'thread',
        container_id: threadId,
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    const pageItems = Array.isArray(resp.data?.items) ? resp.data.items : [];
    items.push(...pageItems);
    pageToken = resp.data?.has_more ? resp.data.page_token : undefined;
  } while (pageToken);

  return items;
}

async function exportTopicHistoryToMarkdown(
  client: Lark.Client,
  options: {
    chatId: string;
    threadId: string;
    sessionKey: string;
    providerName: string;
    contextStartTimeMs?: number;
  },
): Promise<TopicHistoryExportResult> {
  ensureTopicSessionCacheDirs();

  const allMessages = await fetchTopicHistoryMessages(client, options.threadId);
  const filteredMessages = options.contextStartTimeMs
    ? allMessages.filter((item) => {
      const createTimeMs = parseCount(item?.create_time);
      return createTimeMs !== undefined && createTimeMs >= options.contextStartTimeMs!;
    })
    : allMessages;

  const lines: string[] = [
    '# 飞书多主题群聊历史记录',
    '',
    `- chat_id: ${options.chatId}`,
    `- thread_id: ${options.threadId}`,
    `- session_key: ${options.sessionKey}`,
    `- exported_at: ${new Date().toISOString()}`,
    `- total_messages: ${allMessages.length}`,
    `- filtered_messages: ${filteredMessages.length}`,
  ];

  if (options.contextStartTimeMs) {
    lines.push(`- context_start: ${formatHistoryTimestamp(String(options.contextStartTimeMs))}`);
  }

  lines.push('', '## 对话记录', '');

  let exportedMessages = 0;
  for (const item of filteredMessages) {
    const content = extractHistoryMessageText(item);
    if (!content) continue;

    const senderLabel = await resolveHistorySenderLabel(client, item, options.providerName);
    const senderType = item?.sender?.sender_type === 'app' ? 'AI' : '用户';
    lines.push(`### ${senderLabel}（${senderType}） · ${formatHistoryTimestamp(item?.create_time)}`);
    lines.push('');
    lines.push(content);
    lines.push('');
    exportedMessages += 1;
  }

  if (exportedMessages === 0) {
    lines.push('（没有可导出的历史文本消息）', '');
  }

  const filename = `${sanitizeWorkspaceSegment(options.chatId)}__${sanitizeWorkspaceSegment(options.threadId)}__${Date.now()}.md`;
  const filePath = path.join(TOPIC_SESSION_HISTORY_DIR, filename);
  fs.writeFileSync(filePath, `${lines.join('\n').trim()}\n`);

  return {
    filePath,
    totalMessages: allMessages.length,
    exportedMessages,
  };
}

function buildTopicRecoveryPrompt(prompt: string, historyFilePath: string): string {
  return [
    '你当前收到的消息来自飞书多主题群聊。',
    '当前没有找到这个 topic 对应的本地 AI 会话，因此需要恢复上下文。',
    `本地历史文件：${historyFilePath}`,
    '上面的文件只是之前的会话记录，请先读取它，再根据上下文回答用户当前的问题。',
    '如果历史记录与用户当前最新消息冲突，以用户当前最新消息为准。',
    '',
    '【用户当前最新消息】',
    prompt,
  ].join('\n');
}

async function getGroupChatMeta(client: Lark.Client, chatId: string): Promise<GroupChatMeta> {
  const now = Date.now();
  const cached = groupChatMetaCache.get(chatId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  try {
    const resp = await client.im.chat.get({
      params: { user_id_type: 'open_id' },
      path: { chat_id: chatId },
    });
    const data = resp.data || {};
    const groupMessageType = typeof data.group_message_type === 'string' ? data.group_message_type : undefined;
    const chatMode = typeof data.chat_mode === 'string' ? data.chat_mode : undefined;
    const userCount = parseCount(data.user_count);
    const botCount = parseCount(data.bot_count);

    const meta: GroupChatMeta = {
      fetchedAt: now,
      expiresAt: now + GROUP_CHAT_META_TTL_MS,
      isTopicGroup: groupMessageType === 'thread' || chatMode === 'topic',
      isBotUserPairGroup: userCount === 1 && botCount === 1,
      groupMessageType,
      chatMode,
      userCount,
      botCount,
    };

    groupChatMetaCache.set(chatId, meta);
    logFeishuRuntime('chat.meta', {
      chatId,
      groupMessageType: groupMessageType || null,
      chatMode: chatMode || null,
      userCount: userCount ?? null,
      botCount: botCount ?? null,
      isTopicGroup: meta.isTopicGroup,
      isBotUserPairGroup: meta.isBotUserPairGroup,
    });
    return meta;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    const meta: GroupChatMeta = {
      fetchedAt: now,
      expiresAt: now + GROUP_CHAT_META_ERROR_TTL_MS,
      isTopicGroup: false,
      isBotUserPairGroup: false,
      fetchError: errMsg,
    };

    groupChatMetaCache.set(chatId, meta);
    console.warn(`[群信息] 获取失败: ${chatId} | ${errMsg}`);
    logFeishuRuntime('chat.meta.error', {
      chatId,
      error: errMsg,
    });
    return meta;
  }
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

async function sendResponseForIncoming(
  client: Lark.Client,
  _chatId: string,
  incomingMessageId: string,
  _title: string,
  content: string,
  replyInThread = false,
): Promise<string | null> {
  return sendReplyText(client, incomingMessageId, content, replyInThread);
}

async function syncProgressCard(
  client: Lark.Client,
  messageId: string,
  title: string,
  state: ReturnType<typeof createTaskProgressState>,
): Promise<void> {
  await updateCard(
    client,
    messageId,
    title,
    renderTaskProgressMarkdown(state, config.feishuReplyShowUsage),
  );
}

export function startFeishuBot() {
  console.log(`[飞书运行日志] 路径: ${FEISHU_RUNTIME_LOG_PATH}`);
  console.log(`[实例] ${INSTANCE_TAG}`);
  loadTopicSessionCache();
  logFeishuRuntime('service.boot', {
    instance: INSTANCE_TAG,
    pid: process.pid,
    cwd: process.cwd(),
    aiProvider: config.aiProvider,
    configuredWorkspace: config.workspace,
    runtimeWorkspaceRoot: PROJECT_WORKSPACE_ROOT,
    chatTurnTimeoutMs: getChatTurnTimeoutMs(),
    replyOptions: {
      showUsage: config.feishuReplyShowUsage,
      ackReaction: config.feishuReplyAckReaction,
      ackEmoji: config.feishuReplyAckEmoji,
      format: config.feishuReplyFormat,
    },
    feishuAppIdSuffix: config.feishuAppId ? config.feishuAppId.slice(-6) : '',
  });

  const client = new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    loggerLevel: Lark.LoggerLevel.error,
    logger: larkLogger,
  });

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

        // 3. 群聊的 @ 过滤、两人群直连、话题模式判断放到异步处理阶段，避免这里同步查群信息
        const chatType = message.chat_type;
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

  if (config.schedulerEnabled) {
    startSchedulerService(client);
    console.log(`[Scheduler] 已启动 | DB: ${config.schedulerDbPath}`);
  } else {
    console.log('[Scheduler] 未启用');
  }

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
    await sendTextMessage(
      client,
      isOpenId ? 'open_id' : 'chat_id',
      userId,
      `✅ 机器人已启动
目录根: ${PROJECT_WORKSPACE_ROOT}
私聊目录: ${PROJECT_WORKSPACE_ROOT}/user_<open_id>`,
    );
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
  return sendTextMessage(client, receiveIdType, receiveId, `${title}
${content}`);
}

async function handleMessage(client: Lark.Client, data: any) {
  const message = data.message;
  const chatId = message.chat_id;
  const chatType = message.chat_type;
  const incomingMessageId = message.message_id;
  const threadId: string | undefined = message.thread_id || undefined;
  const providerName = getProviderName();
  const groupChatMeta = chatType === 'group' ? await getGroupChatMeta(client, chatId) : null;
  const isTopicGroup = groupChatMeta?.isTopicGroup === true;
  const shouldSendProgressCard = !isTopicGroup;
  // 话题群中按 chatId + threadId 隔离会话，非话题群仅用 chatId
  const sessionKey = buildSessionKey(chatId, isTopicGroup ? threadId : undefined);

  logFeishuRuntime('message.handle.start', {
    instance: INSTANCE_TAG,
    messageId: incomingMessageId,
    chatId,
    threadId: threadId || null,
    sessionKey,
    aiProvider: config.aiProvider,
    groupMessageType: groupChatMeta?.groupMessageType || null,
    isTopicGroup,
    isBotUserPairGroup: groupChatMeta?.isBotUserPairGroup || false,
  });

  if (chatType === 'group') {
    const isMentioned = isMessageMentioningBot(message);
    const allowWithoutMention = groupChatMeta?.isBotUserPairGroup === true;
    if (!isMentioned && !allowWithoutMention) {
      logFeishuRuntime('message.handle.skip.group_not_mentioned', {
        messageId: incomingMessageId,
        chatId,
        groupMessageType: groupChatMeta?.groupMessageType || null,
        userCount: groupChatMeta?.userCount ?? null,
        botCount: groupChatMeta?.botCount ?? null,
      });
      return;
    }

    if (allowWithoutMention && !isMentioned) {
      console.log(`[群聊] 两人群免 @ 触发 | chat_id: ${chatId}`);
      logFeishuRuntime('message.handle.group_direct_trigger', {
        messageId: incomingMessageId,
        chatId,
        userCount: groupChatMeta?.userCount ?? null,
        botCount: groupChatMeta?.botCount ?? null,
      });
    }
  }

  await addAckReaction(client, incomingMessageId);

  if (processing.has(sessionKey)) {
    console.log(`[跳过] 会话 ${sessionKey} 正在处理中`);
    pendingMessages.set(sessionKey, data);

    let queuedCardMessageId = queuedCardMessageIds.get(sessionKey) || null;

    if (shouldSendProgressCard) {
      const waitCardState = createTaskProgressState('等待前一条任务完成');
      if (queuedCardMessageId) {
        await syncProgressCard(client, queuedCardMessageId, providerName, waitCardState);
      } else {
        const waitCardMessageId = await sendCard(
          client,
          'chat_id',
          chatId,
          providerName,
          renderTaskProgressMarkdown(waitCardState, config.feishuReplyShowUsage),
        );
        if (waitCardMessageId) {
          queuedCardMessageIds.set(sessionKey, waitCardMessageId);
          queuedCardMessageId = waitCardMessageId;
        }
      }
    } else if (queuedCardMessageId) {
      queuedCardMessageIds.delete(sessionKey);
      queuedCardMessageId = null;
    }

    logFeishuRuntime('message.handle.skip.processing', {
      messageId: incomingMessageId,
      chatId,
      sessionKey,
      queued: true,
      queuedCardMessageId,
      isTopicGroup,
    });
    return;
  }

  let text = '';
  const inputImages: InputImage[] = [];
  const downloadedImageInputs: DownloadedImageInput[] = [];
  try {
    const parsed = JSON.parse(message.content);
    if (message.message_type === 'post') {
      text = extractPostText(parsed);
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
      await sendResponseForIncoming(client, chatId, incomingMessageId, providerName, `❌ 图片读取失败：${errMsg}`, isTopicGroup);
    }

    return;
  }

  if (chatType === 'group' && data.message?.mentions) {
    for (const mention of data.message.mentions) {
      text = text.replace(`@_user_${mention.id?.union_id}`, '').trim();
      if (mention.name) {
        text = text.replace(`@${mention.name}`, '').trim();
      }
    }
  }

  if (!text && inputImages.length === 0) {
    logFeishuRuntime('message.handle.skip.empty_text', {
      messageId: incomingMessageId,
      chatId,
      messageType: message.message_type,
      content: message.content,
    });
    return;
  }

  console.log(`[消息内容] "${text}"`);

  if (text === '/clear' || text === '/new') {
    console.log(`[命令] 清除会话 | sessionKey: ${sessionKey}`);
    sessions.delete(sessionKey);
    if (isTopicGroup && threadId) {
      upsertTopicSessionCacheEntry({
        sessionKey,
        chatId,
        threadId,
        sessionId: null,
        contextStartTimeMs: Date.now(),
      });
    }
    await sendResponseForIncoming(client, chatId, incomingMessageId, providerName, '✅ 会话已清除，开始新对话', isTopicGroup);
    return;
  }

  if (text === '/stop') {
    console.log(`[命令] 停止处理 | sessionKey: ${sessionKey}`);
    if (abortControllers.has(sessionKey)) {
      abortReasons.set(sessionKey, 'user');
      abortControllers.get(sessionKey)!.abort();
      await sendResponseForIncoming(client, chatId, incomingMessageId, providerName, '⏹️ 已停止当前处理', isTopicGroup);
    } else {
      await sendResponseForIncoming(client, chatId, incomingMessageId, providerName, '💤 当前没有正在处理的任务', isTopicGroup);
    }
    return;
  }

  if (text === '/status') {
    console.log(`[命令] 查询状态 | sessionKey: ${sessionKey}`);
    const hasSession = sessions.has(sessionKey);
    await sendResponseForIncoming(
      client,
      chatId,
      incomingMessageId,
      providerName,
      hasSession ? '📍 当前有活跃会话' : '💤 无活跃会话',
      isTopicGroup,
    );
    return;
  }

  const senderOpenId = data.sender?.sender_id?.open_id;
  const senderName = await resolveSenderName(client, senderOpenId);
  if (senderName && senderOpenId) {
    console.log(`[消息上下文] 当前发送者: ${senderName} (${senderOpenId})`);
  } else if (senderOpenId) {
    console.log(`[消息上下文] 当前发送者 open_id: ${senderOpenId}`);
  }

  const workingDirectory = resolveMessageWorkingDirectory(chatType, senderOpenId);
  try {
    await ensureWorkingDirectory(workingDirectory);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[工作目录] 创建失败: ${workingDirectory} | ${errMsg}`);
    logFeishuRuntime('message.handle.workspace_error', {
      messageId: incomingMessageId,
      chatId,
      chatType,
      senderOpenId: senderOpenId || null,
      workingDirectory,
      error: errMsg,
    });
    await sendResponseForIncoming(client, chatId, incomingMessageId, providerName, `❌ 无法准备用户工作目录：${errMsg}`, isTopicGroup);
    return;
  }

  console.log(`[工作目录] 当前会话目录: ${workingDirectory}`);
  logFeishuRuntime('message.handle.workspace', {
    messageId: incomingMessageId,
    chatId,
    chatType,
    senderOpenId: senderOpenId || null,
    workingDirectory,
  });

  let topicSessionEntry = isTopicGroup && threadId
    ? getTopicSessionCacheEntry(sessionKey)
    : undefined;

  if (isTopicGroup && threadId && (!topicSessionEntry || topicSessionEntry.chatId !== chatId || topicSessionEntry.threadId !== threadId)) {
    topicSessionEntry = upsertTopicSessionCacheEntry({
      sessionKey,
      chatId,
      threadId,
    });
  }

  let taskPrompt = text;
  let sessionId = sessions.get(sessionKey) || null;
  let recoveredHistoryFilePath: string | null = null;

  if (topicSessionEntry?.sessionId && !sessionId) {
    sessionId = topicSessionEntry.sessionId;
    sessions.set(sessionKey, sessionId);
  }

  if (isTopicGroup && threadId && !sessionId) {
    try {
      const historyExport = await exportTopicHistoryToMarkdown(client, {
        chatId,
        threadId,
        sessionKey,
        providerName,
        contextStartTimeMs: topicSessionEntry?.contextStartTimeMs,
      });

      recoveredHistoryFilePath = historyExport.filePath;
      taskPrompt = buildTopicRecoveryPrompt(text, recoveredHistoryFilePath);
      topicSessionEntry = upsertTopicSessionCacheEntry({
        sessionKey,
        chatId,
        threadId,
        historyFilePath: recoveredHistoryFilePath,
      });

      logFeishuRuntime('message.handle.topic_context_recovery', {
        messageId: incomingMessageId,
        chatId,
        threadId,
        sessionKey,
        historyFilePath: recoveredHistoryFilePath,
        totalMessages: historyExport.totalMessages,
        exportedMessages: historyExport.exportedMessages,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      console.error(`[Topic会话恢复] 导出历史失败: ${sessionKey} | ${errMsg}`);
      logFeishuRuntime('message.handle.topic_context_recovery_error', {
        messageId: incomingMessageId,
        chatId,
        threadId,
        sessionKey,
        error: errMsg,
      });

      if (topicSessionEntry?.historyFilePath && fs.existsSync(topicSessionEntry.historyFilePath)) {
        recoveredHistoryFilePath = topicSessionEntry.historyFilePath;
        taskPrompt = buildTopicRecoveryPrompt(text, recoveredHistoryFilePath);
        logFeishuRuntime('message.handle.topic_context_recovery_fallback', {
          messageId: incomingMessageId,
          chatId,
          threadId,
          sessionKey,
          historyFilePath: recoveredHistoryFilePath,
        });
      }
    }
  }

  console.log(`[${providerName}] 开始处理... | sessionKey: ${sessionKey}`);
  processing.add(sessionKey);
  const abortController = new AbortController();
  abortControllers.set(sessionKey, abortController);
  abortReasons.delete(sessionKey);
  const chatTurnTimeoutMs = getChatTurnTimeoutMs();
  const chatTurnTimeoutSec = Math.ceil(chatTurnTimeoutMs / 1000);
  const progressState = createTaskProgressState();
  let progressCardMessageId: string | null = null;

  try {
    if (shouldSendProgressCard) {
      progressCardMessageId = queuedCardMessageIds.get(sessionKey) || null;
      if (progressCardMessageId) {
        queuedCardMessageIds.delete(sessionKey);
        progressState.current = '准备中';
        await syncProgressCard(client, progressCardMessageId, providerName, progressState);
      } else {
        progressCardMessageId = await sendCard(
          client,
          'chat_id',
          chatId,
          providerName,
          renderTaskProgressMarkdown(progressState, config.feishuReplyShowUsage),
        );
      }
    } else {
      queuedCardMessageIds.delete(sessionKey);
      logFeishuRuntime('message.handle.progress_card.skip', {
        messageId: incomingMessageId,
        chatId,
        reason: 'topic_group',
        groupMessageType: groupChatMeta?.groupMessageType || null,
      });
    }

    logFeishuRuntime('message.handle.progress_card', {
      messageId: incomingMessageId,
      chatId,
      progressCardMessageId,
      isTopicGroup,
    });

    const result = await executeTask({
      prompt: taskPrompt,
      sessionId,
      timeoutMs: chatTurnTimeoutMs,
      abortSignal: abortController.signal,
      externalAbortReason: () => (abortReasons.get(sessionKey) === 'user' ? 'user' : 'external'),
      feishuClient: client,
      chatId,
      senderOpenId,
      senderName,
      inputImages,
      workingDirectory,
      onProgress: async (state, event) => {
        switch (event.type) {
          case 'tool_start':
            console.log(`[${providerName}] 工具调用: ${event.toolName || '工具'}`);
            break;
          case 'tool_end':
            console.log(`[${providerName}] 工具输入: ${event.toolInput?.slice(0, 100) || ''}...`);
            break;
          case 'tool_result':
            console.log(`[${providerName}] 工具结果: ${event.toolOutput?.slice(0, 100) || ''}...`);
            break;
          case 'result':
            console.log(`[${providerName}] 处理完成`);
            break;
          case 'error':
            console.log(`[${providerName}] 错误: ${event.content || '未知错误'}`);
            break;
          default:
            break;
        }

        if (progressCardMessageId) {
          await syncProgressCard(client, progressCardMessageId, providerName, state);
        }
      },
    });

    if (isTopicGroup && threadId) {
      topicSessionEntry = upsertTopicSessionCacheEntry({
        sessionKey,
        chatId,
        threadId,
        sessionId: result.sessionId || sessionId || null,
        ...(recoveredHistoryFilePath ? { historyFilePath: recoveredHistoryFilePath } : {}),
        ...(topicSessionEntry?.contextStartTimeMs !== undefined
          ? { contextStartTimeMs: topicSessionEntry.contextStartTimeMs }
          : {}),
      });
    } else if (result.sessionId) {
      sessions.set(sessionKey, result.sessionId);
    }

    let finalReplyText = result.content.trim();
    if (!finalReplyText) {
      if (result.status === 'aborted') {
        if (result.abortReason === 'timeout') {
          logFeishuRuntime('message.handle.timeout.abort', {
            chatId,
            messageId: incomingMessageId,
            timeoutMs: chatTurnTimeoutMs,
          });
          finalReplyText = `⏱️ 执行超时（>${chatTurnTimeoutSec}s），已自动停止。`;
        } else {
          finalReplyText = '⏹️ 已被用户停止';
        }
      } else if (result.status === 'error') {
        finalReplyText = `❌ 错误：${result.errorMessage || '未知错误'}`;
      } else {
        finalReplyText = '（无响应）';
      }
    }

    if (!progressCardMessageId && result.usageInfo && config.feishuReplyShowUsage) {
      finalReplyText += formatUsageInfo(result.usageInfo);
    }

    await sendReplyText(client, incomingMessageId, finalReplyText, isTopicGroup);

    logFeishuRuntime('message.handle.done', {
      instance: INSTANCE_TAG,
      messageId: incomingMessageId,
      chatId,
      responseMessageId: incomingMessageId,
      progressCardMessageId,
      isTopicGroup,
      status: result.status,
      abortReason: result.abortReason || null,
      hasResult: Boolean(result.content),
      toolCallCount: result.progress.toolCallCount,
      reasoningCount: result.progress.reasoningCount,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[错误] ${providerName} 处理失败: ${errMsg}`);
    logFeishuRuntime('message.handle.error', {
      instance: INSTANCE_TAG,
      messageId: incomingMessageId,
      chatId,
      isTopicGroup,
      error: errMsg,
    });

    progressState.current = '执行出错';
    if (progressCardMessageId) {
      await syncProgressCard(client, progressCardMessageId, providerName, progressState);
    }
    await sendReplyText(client, incomingMessageId, `❌ 错误: ${errMsg}`, isTopicGroup);
  } finally {
    processing.delete(sessionKey);
    abortControllers.delete(sessionKey);
    abortReasons.delete(sessionKey);

    const pending = pendingMessages.get(sessionKey);
    if (pending) {
      pendingMessages.delete(sessionKey);
      logFeishuRuntime('message.handle.dequeue', {
        chatId,
        sessionKey,
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
