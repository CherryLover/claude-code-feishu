import fs from 'fs';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import {
  sendCard,
  sendTextMessage,
  updateCard,
} from '../feishu/messages.js';
import { getProviderName } from '../providers/index.js';
import { executeTask } from '../core/task-executor.js';
import { renderTaskProgressMarkdown } from '../core/task-progress.js';
import {
  createScheduleRun,
  markScheduleRunFailed,
  markScheduleRunSuccess,
} from './db.js';
import { ScheduleRecord } from './types.js';

export interface RunScheduledTaskOptions {
  trigger?: 'cron' | 'manual';
  plannedAt?: string;
}

export interface RunScheduledTaskResult {
  runId: number;
  outputMessageId: string | null;
  status: 'success' | 'failed';
}

function formatReportTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
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

function buildScheduledReport(
  schedule: ScheduleRecord,
  plannedAt: string,
  trigger: 'cron' | 'manual',
  body: string,
): string {
  const triggerLabel = trigger === 'manual' ? '手动执行' : '定时触发';
  return [
    `**${schedule.name}**`,
    `执行时间：${formatReportTime(plannedAt)}`,
    `触发方式：${triggerLabel}`,
    '',
    body.trim() || '（无响应）',
  ].join('\n');
}

function buildFailureMessage(
  schedule: ScheduleRecord,
  plannedAt: string,
  trigger: 'cron' | 'manual',
  errorMessage: string,
): string {
  return buildScheduledReport(
    schedule,
    plannedAt,
    trigger,
    `❌ 执行失败\n\n${errorMessage}`,
  );
}

export async function runScheduledTask(
  client: Lark.Client,
  schedule: ScheduleRecord,
  options: RunScheduledTaskOptions = {},
): Promise<RunScheduledTaskResult> {
  const trigger = options.trigger || 'cron';
  const plannedAt = options.plannedAt || new Date().toISOString();
  const startedAt = new Date().toISOString();
  const runId = createScheduleRun(schedule.id, plannedAt, startedAt);
  const providerName = getProviderName();
  const title = `${providerName} 定时任务`;

  await fs.promises.mkdir(schedule.workingDirectory, { recursive: true });

  let progressCardMessageId = await sendCard(
    client,
    schedule.targetType,
    schedule.targetId,
    title,
    renderTaskProgressMarkdown({
      current: `准备执行 · ${schedule.name}`,
      toolCallCount: 0,
      reasoningCount: 0,
      startedAt: Date.now(),
      answerPhaseStarted: false,
    }),
  );

  try {
    const result = await executeTask({
      prompt: schedule.prompt,
      sessionId: null,
      timeoutMs: config.schedulerTaskTimeoutMs,
      feishuClient: client,
      chatId: schedule.targetType === 'chat_id' ? schedule.targetId : undefined,
      workingDirectory: schedule.workingDirectory,
      onProgress: async (state) => {
        if (!progressCardMessageId) return;
        await updateCard(
          client,
          progressCardMessageId,
          title,
          renderTaskProgressMarkdown(state),
        );
      },
    });

    const finishedAt = new Date().toISOString();
    const reportBody = (() => {
      if (result.status === 'success') {
        return result.content.trim() || '（无响应）';
      }
      if (result.status === 'aborted') {
        return result.abortReason === 'timeout'
          ? `⏱️ 执行超时（>${Math.ceil(config.schedulerTaskTimeoutMs / 1000)}s），已自动停止。`
          : '⏹️ 定时任务已停止。';
      }
      return `❌ 错误：${result.errorMessage || '未知错误'}`;
    })();

    const outputMessageId = await sendTextMessage(
      client,
      schedule.targetType,
      schedule.targetId,
      buildScheduledReport(schedule, plannedAt, trigger, reportBody),
    );

    if (!outputMessageId) {
      throw new Error('飞书结果消息发送失败');
    }

    if (progressCardMessageId) {
      result.progress.current = result.status === 'success' ? '报告已发送' : '报告已发送（执行失败）';
      await updateCard(
        client,
        progressCardMessageId,
        title,
        renderTaskProgressMarkdown(result.progress),
      );
    }

    if (result.status === 'success') {
      markScheduleRunSuccess(
        runId,
        schedule.id,
        finishedAt,
        result.content.trim() || '（无响应）',
        outputMessageId,
      );
      return {
        runId,
        outputMessageId,
        status: 'success',
      };
    }

    const errorMessage = result.status === 'aborted'
      ? (result.abortReason === 'timeout'
        ? `执行超时（>${Math.ceil(config.schedulerTaskTimeoutMs / 1000)}s）`
        : '任务已停止')
      : (result.errorMessage || '未知错误');
    markScheduleRunFailed(runId, finishedAt, errorMessage);
    return {
      runId,
      outputMessageId,
      status: 'failed',
    };
  } catch (error: unknown) {
    const finishedAt = new Date().toISOString();
    const errMsg = error instanceof Error ? error.message : '未知错误';
    markScheduleRunFailed(runId, finishedAt, errMsg);

    if (progressCardMessageId) {
      await updateCard(
        client,
        progressCardMessageId,
        title,
        renderTaskProgressMarkdown({
          current: '报告发送失败',
          toolCallCount: 0,
          reasoningCount: 0,
          startedAt: Date.now(),
          answerPhaseStarted: false,
        }),
      );
    }

    const fallbackMessageId = await sendTextMessage(
      client,
      schedule.targetType,
      schedule.targetId,
      buildFailureMessage(schedule, plannedAt, trigger, errMsg),
    );

    return {
      runId,
      outputMessageId: fallbackMessageId,
      status: 'failed',
    };
  }
}
