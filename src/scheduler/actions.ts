import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import cron from 'node-cron';
import { config } from '../config.js';
import { getSchedulerService } from './service.js';
import {
  createSchedule,
  deleteSchedule,
  getScheduleById,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
} from './db.js';
import { runScheduledTask } from './runner.js';
import { ScheduleRecord, ScheduleTargetType } from './types.js';

export interface SchedulerToolContext {
  defaultTargetType?: ScheduleTargetType;
  defaultTargetId?: string;
  defaultWorkingDirectory?: string;
  client?: Lark.Client;
}

export interface ScheduleCreateArgs {
  id?: string;
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  target_type?: ScheduleTargetType;
  target_id?: string;
  working_directory?: string;
}

export interface ScheduleUpdateArgs {
  id: string;
  name?: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  target_type?: ScheduleTargetType;
  target_id?: string;
  working_directory?: string;
}

function validateTargetType(value: string | undefined): ScheduleTargetType {
  if (!value || value === 'chat_id' || value === 'open_id') {
    return (value || 'chat_id') as ScheduleTargetType;
  }

  throw new Error(`target_type 只支持 chat_id 或 open_id，当前: ${value}`);
}

function validateCron(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('cron 不能为空');
  }
  if (!cron.validate(normalized)) {
    throw new Error(`非法 cron 表达式: ${normalized}`);
  }
  return normalized;
}

function slugifyScheduleId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'schedule';
}

function ensureUniqueScheduleId(baseId: string): string {
  let candidate = slugifyScheduleId(baseId);
  let suffix = 2;

  while (getScheduleById(candidate)) {
    candidate = `${slugifyScheduleId(baseId)}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function resolveWorkingDirectory(
  workingDirectory: string | undefined,
  context?: SchedulerToolContext,
): string {
  const fallback = context?.defaultWorkingDirectory || config.workspace;
  const resolved = path.resolve(workingDirectory || fallback);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function getActivationMessage(): string {
  const schedulerService = getSchedulerService();
  if (schedulerService) {
    return '已立即同步到当前调度器。';
  }
  if (config.schedulerEnabled) {
    return '已写入 SQLite，运行中的调度器会在几秒内自动同步。';
  }
  return '已写入 SQLite；当前机器人未启用调度器，需开启 SCHEDULER_ENABLED 后才会执行。';
}

function syncSchedulerRuntime(): void {
  const schedulerService = getSchedulerService();
  if (schedulerService) {
    schedulerService.reloadAllSchedules();
  }
}

function formatScheduleLine(schedule: ScheduleRecord): string {
  return [
    `ID: ${schedule.id}`,
    `名称: ${schedule.name}`,
    `状态: ${schedule.enabled ? '启用' : '停用'}`,
    `Cron: ${schedule.cron}`,
    `时区: ${schedule.timezone}`,
    `目标: ${schedule.targetType}:${schedule.targetId}`,
    `目录: ${schedule.workingDirectory}`,
    `最近执行: ${schedule.lastRunAt || '未执行'}`,
  ].join('\n');
}

function buildSchedulerClient(context?: SchedulerToolContext): Lark.Client {
  if (context?.client) {
    return context.client;
  }

  return new Lark.Client({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });
}

export function listSchedulesAction(includeDisabled = true): string {
  const schedules = listSchedules(includeDisabled);
  if (schedules.length === 0) {
    return '当前没有定时任务。';
  }

  return [
    `共 ${schedules.length} 个定时任务：`,
    ...schedules.map((schedule, index) => `${index + 1}.\n${formatScheduleLine(schedule)}`),
  ].join('\n\n');
}

export function createScheduleAction(args: ScheduleCreateArgs, context?: SchedulerToolContext): string {
  const name = args.name.trim();
  const prompt = args.prompt.trim();
  if (!name) {
    throw new Error('name 不能为空');
  }
  if (!prompt) {
    throw new Error('prompt 不能为空');
  }

  const targetType = validateTargetType(args.target_type || context?.defaultTargetType);
  const targetId = args.target_id?.trim() || context?.defaultTargetId;
  if (!targetId) {
    throw new Error('缺少 target_id。当前上下文无法自动推断时，请显式提供 target_id。');
  }

  const workingDirectory = resolveWorkingDirectory(args.working_directory, context);
  const scheduleId = args.id?.trim()
    ? slugifyScheduleId(args.id)
    : ensureUniqueScheduleId(name);

  if (args.id?.trim() && getScheduleById(scheduleId)) {
    throw new Error(`定时任务 ID 已存在: ${scheduleId}`);
  }

  const created = createSchedule({
    id: scheduleId,
    name,
    cron: validateCron(args.cron),
    timezone: args.timezone?.trim() || 'Asia/Shanghai',
    prompt,
    targetType,
    targetId,
    workingDirectory,
    enabled: true,
  });

  syncSchedulerRuntime();

  return [
    '已创建定时任务。',
    formatScheduleLine(created),
    `执行内容: ${created.prompt}`,
    `生效状态: ${getActivationMessage()}`,
  ].join('\n');
}

export function updateScheduleAction(args: ScheduleUpdateArgs, context?: SchedulerToolContext): string {
  const existing = getScheduleById(args.id);
  if (!existing) {
    throw new Error(`定时任务不存在: ${args.id}`);
  }

  const patch: {
    name?: string;
    cron?: string;
    timezone?: string;
    prompt?: string;
    targetType?: ScheduleTargetType;
    targetId?: string;
    workingDirectory?: string;
  } = {};

  if (args.name !== undefined) patch.name = args.name.trim();
  if (args.cron !== undefined) patch.cron = validateCron(args.cron);
  if (args.timezone !== undefined) patch.timezone = args.timezone.trim() || existing.timezone;
  if (args.prompt !== undefined) patch.prompt = args.prompt.trim();
  if (args.target_type !== undefined) patch.targetType = validateTargetType(args.target_type);
  if (args.target_id !== undefined) patch.targetId = args.target_id.trim();
  if (args.working_directory !== undefined) {
    patch.workingDirectory = resolveWorkingDirectory(args.working_directory, context);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('没有可更新的字段');
  }

  const updated = updateSchedule(args.id, patch);
  syncSchedulerRuntime();

  return [
    '已更新定时任务。',
    formatScheduleLine(updated),
    `执行内容: ${updated.prompt}`,
    `生效状态: ${getActivationMessage()}`,
  ].join('\n');
}

export function enableScheduleAction(id: string): string {
  const updated = setScheduleEnabled(id, true);
  syncSchedulerRuntime();
  return [
    '已启用定时任务。',
    formatScheduleLine(updated),
    `生效状态: ${getActivationMessage()}`,
  ].join('\n');
}

export function disableScheduleAction(id: string): string {
  const updated = setScheduleEnabled(id, false);
  syncSchedulerRuntime();
  return [
    '已停用定时任务。',
    formatScheduleLine(updated),
    `生效状态: ${getActivationMessage()}`,
  ].join('\n');
}

export function deleteScheduleAction(id: string): string {
  const existing = getScheduleById(id);
  if (!existing) {
    throw new Error(`定时任务不存在: ${id}`);
  }

  deleteSchedule(id);
  syncSchedulerRuntime();

  return [
    '已删除定时任务。',
    `ID: ${existing.id}`,
    `名称: ${existing.name}`,
    `生效状态: ${getActivationMessage()}`,
  ].join('\n');
}

export async function runScheduleNowAction(id: string, context?: SchedulerToolContext): Promise<string> {
  const existing = getScheduleById(id);
  if (!existing) {
    throw new Error(`定时任务不存在: ${id}`);
  }

  const client = buildSchedulerClient(context);
  const result = await runScheduledTask(client, existing, { trigger: 'manual' });

  return [
    '已执行定时任务。',
    formatScheduleLine(existing),
    `执行结果: ${result.status}`,
    `运行记录 ID: ${result.runId}`,
    `输出消息 ID: ${result.outputMessageId || '发送失败'}`,
  ].join('\n');
}
