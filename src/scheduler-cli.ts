import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import {
  createSchedule,
  deleteSchedule,
  getScheduleById,
  listScheduleRuns,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
} from './scheduler/db.js';
import { runScheduledTask } from './scheduler/runner.js';
import { CreateScheduleInput, ScheduleTargetType, UpdateScheduleInput } from './scheduler/types.js';

interface ParsedArgs {
  command: string;
  values: Map<string, string>;
}

function printUsage(): void {
  console.log(`用法:
  npm run schedule -- list
  npm run schedule -- runs [--id <schedule-id>] [--limit 20]
  npm run schedule -- add --id <id> --name <name> --cron "<expr>" --target-type <chat_id|open_id> --target-id <id> --working-directory <path> (--prompt <text> | --prompt-file <file>) [--timezone Asia/Shanghai]
  npm run schedule -- update --id <id> [--name <name>] [--cron "<expr>"] [--target-type <chat_id|open_id>] [--target-id <id>] [--working-directory <path>] [--timezone <tz>] [--prompt <text> | --prompt-file <file>]
  npm run schedule -- enable --id <id>
  npm run schedule -- disable --id <id>
  npm run schedule -- delete --id <id>
  npm run schedule -- run --id <id>`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的参数: ${token}`);
    }

    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`参数缺少值: --${key}`);
    }

    values.set(key, value);
    index += 1;
  }

  return { command, values };
}

function getRequiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`缺少必填参数: --${key}`);
  }
  return value;
}

function readPrompt(values: Map<string, string>): string | undefined {
  const inlinePrompt = values.get('prompt');
  const promptFile = values.get('prompt-file');

  if (inlinePrompt && promptFile) {
    throw new Error('--prompt 和 --prompt-file 只能二选一');
  }

  if (inlinePrompt) {
    return inlinePrompt.trim();
  }

  if (promptFile) {
    const filePath = path.resolve(promptFile);
    return fs.readFileSync(filePath, 'utf-8').trim();
  }

  return undefined;
}

function normalizeTargetType(value: string): ScheduleTargetType {
  if (value !== 'chat_id' && value !== 'open_id') {
    throw new Error(`target-type 只支持 chat_id 或 open_id，当前: ${value}`);
  }
  return value;
}

function normalizeCron(value: string): string {
  if (!cron.validate(value)) {
    throw new Error(`非法 cron 表达式: ${value}`);
  }
  return value;
}

function normalizeWorkingDirectory(value: string): string {
  return path.resolve(value);
}

async function runCommand(args: ParsedArgs): Promise<void> {
  switch (args.command) {
    case 'help':
      printUsage();
      return;
    case 'list': {
      const schedules = listSchedules(true);
      if (schedules.length === 0) {
        console.log('当前没有定时任务');
        return;
      }

      console.table(schedules.map((item) => ({
        id: item.id,
        name: item.name,
        enabled: item.enabled,
        cron: item.cron,
        timezone: item.timezone,
        target: `${item.targetType}:${item.targetId}`,
        workingDirectory: item.workingDirectory,
        lastRunAt: item.lastRunAt || '',
      })));
      return;
    }
    case 'runs': {
      const scheduleId = args.values.get('id');
      const limit = Number(args.values.get('limit') || 20);
      const runs = listScheduleRuns(scheduleId, Number.isFinite(limit) ? limit : 20);
      if (runs.length === 0) {
        console.log('当前没有执行记录');
        return;
      }

      console.table(runs.map((item) => ({
        id: item.id,
        scheduleId: item.scheduleId,
        plannedAt: item.plannedAt,
        startedAt: item.startedAt || '',
        finishedAt: item.finishedAt || '',
        status: item.status,
        outputMessageId: item.outputMessageId || '',
      })));
      return;
    }
    case 'add': {
      const prompt = readPrompt(args.values);
      if (!prompt) {
        throw new Error('add 需要 --prompt 或 --prompt-file');
      }

      const input: CreateScheduleInput = {
        id: getRequiredValue(args.values, 'id'),
        name: getRequiredValue(args.values, 'name'),
        cron: normalizeCron(getRequiredValue(args.values, 'cron')),
        timezone: args.values.get('timezone') || 'Asia/Shanghai',
        prompt,
        targetType: normalizeTargetType(getRequiredValue(args.values, 'target-type')),
        targetId: getRequiredValue(args.values, 'target-id'),
        workingDirectory: normalizeWorkingDirectory(getRequiredValue(args.values, 'working-directory')),
        enabled: true,
      };

      const created = createSchedule(input);
      console.log(`已创建定时任务: ${created.id}`);
      return;
    }
    case 'update': {
      const id = getRequiredValue(args.values, 'id');
      const patch: UpdateScheduleInput = {};
      if (args.values.has('name')) patch.name = args.values.get('name');
      if (args.values.has('cron')) patch.cron = normalizeCron(getRequiredValue(args.values, 'cron'));
      if (args.values.has('timezone')) patch.timezone = getRequiredValue(args.values, 'timezone');
      if (args.values.has('target-type')) patch.targetType = normalizeTargetType(getRequiredValue(args.values, 'target-type'));
      if (args.values.has('target-id')) patch.targetId = getRequiredValue(args.values, 'target-id');
      if (args.values.has('working-directory')) {
        patch.workingDirectory = normalizeWorkingDirectory(getRequiredValue(args.values, 'working-directory'));
      }
      const prompt = readPrompt(args.values);
      if (prompt !== undefined) patch.prompt = prompt;

      if (Object.keys(patch).length === 0) {
        throw new Error('update 至少需要提供一个可更新字段');
      }

      const updated = updateSchedule(id, patch);
      console.log(`已更新定时任务: ${updated.id}`);
      return;
    }
    case 'enable': {
      const id = getRequiredValue(args.values, 'id');
      setScheduleEnabled(id, true);
      console.log(`已启用定时任务: ${id}`);
      return;
    }
    case 'disable': {
      const id = getRequiredValue(args.values, 'id');
      setScheduleEnabled(id, false);
      console.log(`已停用定时任务: ${id}`);
      return;
    }
    case 'delete': {
      const id = getRequiredValue(args.values, 'id');
      deleteSchedule(id);
      console.log(`已删除定时任务: ${id}`);
      return;
    }
    case 'run': {
      const id = getRequiredValue(args.values, 'id');
      const schedule = getScheduleById(id);
      if (!schedule) {
        throw new Error(`定时任务不存在: ${id}`);
      }

      validateConfig();
      const client = new Lark.Client({
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
      });

      const result = await runScheduledTask(client, schedule, { trigger: 'manual' });
      console.log(`执行完成: ${id} -> ${result.status} (runId=${result.runId})`);
      return;
    }
    default:
      throw new Error(`未知命令: ${args.command}`);
  }
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    await runCommand(args);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : '未知错误';
    console.error(`[schedule-cli] ${errMsg}`);
    printUsage();
    process.exitCode = 1;
  }
}

void main();
