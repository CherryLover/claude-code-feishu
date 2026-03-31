import * as Lark from '@larksuiteoapi/node-sdk';
import { buildFeishuCard } from './formatter.js';
import { config } from './config.js';
import { UsageInfo } from './types.js';

const MAX_REPLY_TEXT_LENGTH = 6000;

function isReplyMarkdownMode(): boolean {
  return config.feishuReplyFormat === 'md';
}

function trimReplyText(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '（空内容）';
  if (normalized.length <= MAX_REPLY_TEXT_LENGTH) return normalized;
  const remain = normalized.length - MAX_REPLY_TEXT_LENGTH;
  return `${normalized.slice(0, MAX_REPLY_TEXT_LENGTH)}\n...(已截断 ${remain} 字符)`;
}

function buildReplyMarkdownPostContent(content: string): string {
  const markdown = trimReplyText(content);
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text: markdown,
          },
        ],
      ],
    },
  });
}

export async function sendPlainTextMessage(
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

export async function sendMarkdownMessage(
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
        msg_type: 'post',
        content: buildReplyMarkdownPostContent(content),
      },
    });
    const messageId = resp.data?.message_id;
    console.log(`[飞书] Markdown 富文本消息发送成功, message_id: ${messageId}`);
    return messageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] Markdown 富文本消息发送失败: ${errMsg}`);
    return null;
  }
}

export async function sendTextMessage(
  client: Lark.Client,
  receiveIdType: 'chat_id' | 'open_id',
  receiveId: string,
  content: string,
): Promise<string | null> {
  if (isReplyMarkdownMode()) {
    const messageId = await sendMarkdownMessage(client, receiveIdType, receiveId, content);
    if (messageId) return messageId;
    console.warn('[飞书] Markdown 消息发送失败，回退为纯文本');
  }

  return sendPlainTextMessage(client, receiveIdType, receiveId, content);
}

export async function sendPlainReplyText(
  client: Lark.Client,
  messageId: string,
  content: string,
  replyInThread = false,
): Promise<string | null> {
  try {
    const resp = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: trimReplyText(content) }),
        reply_in_thread: replyInThread,
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

export async function sendMarkdownReply(
  client: Lark.Client,
  messageId: string,
  content: string,
  replyInThread = false,
): Promise<string | null> {
  try {
    const resp = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'post',
        content: buildReplyMarkdownPostContent(content),
        reply_in_thread: replyInThread,
      },
    });
    const replyMessageId = resp.data?.message_id;
    console.log(`[飞书] Markdown 富文本回复发送成功, message_id: ${replyMessageId}`);
    return replyMessageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] Markdown 富文本回复发送失败: ${errMsg}`);
    return null;
  }
}

export async function sendReplyText(
  client: Lark.Client,
  messageId: string,
  content: string,
  replyInThread = false,
): Promise<string | null> {
  if (isReplyMarkdownMode()) {
    const replyMessageId = await sendMarkdownReply(client, messageId, content, replyInThread);
    if (replyMessageId) return replyMessageId;
    console.warn('[飞书] Markdown 回复失败，回退为纯文本回复');
  }

  return sendPlainReplyText(client, messageId, content, replyInThread);
}

export async function sendCard(
  client: Lark.Client,
  receiveIdType: 'chat_id' | 'open_id',
  receiveId: string,
  title: string,
  content: string,
  copyContent?: string,
): Promise<string | null> {
  try {
    const resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: buildFeishuCard(title, content, copyContent),
      },
    });
    const messageId = resp.data?.message_id;
    console.log(`[飞书] 卡片发送成功, message_id: ${messageId}`);
    return messageId || null;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 卡片发送失败: ${errMsg}`);
    return null;
  }
}

export async function updateCard(
  client: Lark.Client,
  messageId: string,
  title: string,
  content: string,
  copyContent?: string,
): Promise<void> {
  try {
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildFeishuCard(title, content, copyContent),
      },
    });
    console.log('[飞书] 卡片更新成功');
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[飞书] 卡片更新失败: ${errMsg}`);
  }
}

export async function addAckReaction(client: Lark.Client, messageId: string): Promise<void> {
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

export function formatUsageInfo(usage: UsageInfo): string {
  const used = usage.inputTokens + usage.outputTokens;
  const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

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
