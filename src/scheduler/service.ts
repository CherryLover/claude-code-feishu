import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import cron, { ScheduledTask } from 'node-cron';
import { getScheduleById, listSchedules } from './db.js';
import { runScheduledTask } from './runner.js';
import { ScheduleRecord } from './types.js';

const LOG_DIR = path.resolve(process.cwd(), 'log');
const SCHEDULER_LOG_PATH = path.join(LOG_DIR, 'scheduler-runtime.log');
const SCHEDULER_SYNC_INTERVAL_MS = 5_000;

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logSchedulerRuntime(eventType: string, data: unknown): void {
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
  fs.appendFileSync(SCHEDULER_LOG_PATH, `[${timestamp}] [${eventType}] ${payload}\n`);
}

export class SchedulerService {
  private readonly tasks = new Map<string, ScheduledTask>();
  private syncTimer: NodeJS.Timeout | null = null;
  private scheduleSignature = '';

  constructor(private readonly client: Lark.Client) {}

  start(): void {
    this.syncFromDatabase('start', true);
    this.syncTimer = setInterval(() => {
      this.syncFromDatabase('poll');
    }, SCHEDULER_SYNC_INTERVAL_MS);

    logSchedulerRuntime('scheduler.start', {
      logPath: SCHEDULER_LOG_PATH,
      syncIntervalMs: SCHEDULER_SYNC_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.destroyRegisteredTasks();
  }

  reloadAllSchedules(): void {
    this.syncFromDatabase('manual', true);
  }

  reloadSchedule(_id: string): void {
    this.syncFromDatabase('manual', true);
  }

  async runScheduleNow(id: string): Promise<void> {
    const schedule = getScheduleById(id);
    if (!schedule) {
      throw new Error(`定时任务不存在: ${id}`);
    }
    await this.executeSchedule(schedule, 'manual');
  }

  private destroyRegisteredTasks(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      task.destroy();
      logSchedulerRuntime('scheduler.stop.task', { scheduleId: id });
    }
    this.tasks.clear();
  }

  private buildScheduleSignature(schedules: ScheduleRecord[]): string {
    return JSON.stringify(schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      targetType: schedule.targetType,
      targetId: schedule.targetId,
      workingDirectory: schedule.workingDirectory,
    })));
  }

  private syncFromDatabase(reason: 'start' | 'poll' | 'manual', force = false): void {
    const schedules = listSchedules(false);
    const nextSignature = this.buildScheduleSignature(schedules);
    if (!force && nextSignature === this.scheduleSignature) {
      return;
    }

    this.scheduleSignature = nextSignature;
    this.destroyRegisteredTasks();
    for (const schedule of schedules) {
      this.registerSchedule(schedule);
    }

    logSchedulerRuntime('scheduler.sync', {
      reason,
      count: schedules.length,
    });
  }

  private registerSchedule(schedule: ScheduleRecord): void {
    if (!cron.validate(schedule.cron)) {
      logSchedulerRuntime('scheduler.invalid_cron', {
        scheduleId: schedule.id,
        cron: schedule.cron,
      });
      console.error(`[Scheduler] 非法 cron 表达式，已跳过: ${schedule.id} -> ${schedule.cron}`);
      return;
    }

    const task = cron.schedule(
      schedule.cron,
      async () => {
        await this.executeSchedule(schedule, 'cron');
      },
      {
        timezone: schedule.timezone,
        noOverlap: true,
        name: schedule.name,
      },
    );

    this.tasks.set(schedule.id, task);
    logSchedulerRuntime('scheduler.register', {
      scheduleId: schedule.id,
      cron: schedule.cron,
      timezone: schedule.timezone,
      targetType: schedule.targetType,
      targetId: schedule.targetId,
    });
  }

  private async executeSchedule(
    schedule: ScheduleRecord,
    trigger: 'cron' | 'manual',
  ): Promise<void> {
    logSchedulerRuntime('scheduler.execute.start', {
      scheduleId: schedule.id,
      trigger,
    });

    try {
      const result = await runScheduledTask(this.client, schedule, { trigger });
      logSchedulerRuntime('scheduler.execute.done', {
        scheduleId: schedule.id,
        trigger,
        runId: result.runId,
        status: result.status,
        outputMessageId: result.outputMessageId,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';
      logSchedulerRuntime('scheduler.execute.error', {
        scheduleId: schedule.id,
        trigger,
        error: errMsg,
      });
      console.error(`[Scheduler] 执行失败: ${schedule.id} | ${errMsg}`);
    }
  }
}

let schedulerService: SchedulerService | null = null;

export function startSchedulerService(client: Lark.Client): SchedulerService {
  if (schedulerService) {
    return schedulerService;
  }

  schedulerService = new SchedulerService(client);
  schedulerService.start();
  return schedulerService;
}

export function getSchedulerService(): SchedulerService | null {
  return schedulerService;
}
