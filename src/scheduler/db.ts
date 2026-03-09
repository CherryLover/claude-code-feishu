import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRunRecord,
  UpdateScheduleInput,
} from './types.js';

interface ScheduleRow {
  id: string;
  name: string;
  enabled: number;
  cron: string;
  timezone: string;
  prompt: string;
  target_type: string;
  target_id: string;
  working_directory: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ScheduleRunRow {
  id: number;
  schedule_id: string;
  planned_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: 'running' | 'success' | 'failed';
  result_text: string | null;
  error_message: string | null;
  output_message_id: string | null;
}

let db: Database.Database | null = null;

function normalizeSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    targetType: row.target_type as ScheduleRecord['targetType'],
    targetId: row.target_id,
    workingDirectory: row.working_directory,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeScheduleRun(row: ScheduleRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    plannedAt: row.planned_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    resultText: row.result_text,
    errorMessage: row.error_message,
    outputMessageId: row.output_message_id,
  };
}

function ensureDb(): Database.Database {
  if (db) return db;

  const dbPath = config.schedulerDbPath;
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      prompt TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT NOT NULL,
      planned_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status TEXT NOT NULL,
      result_text TEXT,
      error_message TEXT,
      output_message_id TEXT,
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_planned_at ON schedule_runs(planned_at);
  `);

  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getSchedulerDb(): Database.Database {
  return ensureDb();
}

export function listSchedules(includeDisabled = true): ScheduleRecord[] {
  const database = ensureDb();
  const stmt = includeDisabled
    ? database.prepare<[], ScheduleRow>('SELECT * FROM schedules ORDER BY created_at ASC')
    : database.prepare<[], ScheduleRow>('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at ASC');
  return stmt.all().map(normalizeSchedule);
}

export function getScheduleById(id: string): ScheduleRecord | null {
  const database = ensureDb();
  const row = database
    .prepare<[string], ScheduleRow>('SELECT * FROM schedules WHERE id = ?')
    .get(id);
  return row ? normalizeSchedule(row) : null;
}

export function createSchedule(input: CreateScheduleInput): ScheduleRecord {
  const database = ensureDb();
  const now = nowIso();
  database.prepare(`
    INSERT INTO schedules (
      id, name, enabled, cron, timezone, prompt, target_type, target_id, working_directory, created_at, updated_at
    ) VALUES (
      @id, @name, @enabled, @cron, @timezone, @prompt, @target_type, @target_id, @working_directory, @created_at, @updated_at
    )
  `).run({
    id: input.id,
    name: input.name,
    enabled: input.enabled === false ? 0 : 1,
    cron: input.cron,
    timezone: input.timezone || 'Asia/Shanghai',
    prompt: input.prompt,
    target_type: input.targetType,
    target_id: input.targetId,
    working_directory: input.workingDirectory,
    created_at: now,
    updated_at: now,
  });

  const created = getScheduleById(input.id);
  if (!created) {
    throw new Error(`创建定时任务失败: ${input.id}`);
  }
  return created;
}

export function updateSchedule(id: string, patch: UpdateScheduleInput): ScheduleRecord {
  const existing = getScheduleById(id);
  if (!existing) {
    throw new Error(`定时任务不存在: ${id}`);
  }

  const database = ensureDb();
  database.prepare(`
    UPDATE schedules
    SET
      name = @name,
      enabled = @enabled,
      cron = @cron,
      timezone = @timezone,
      prompt = @prompt,
      target_type = @target_type,
      target_id = @target_id,
      working_directory = @working_directory,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    name: patch.name ?? existing.name,
    enabled: patch.enabled === undefined ? (existing.enabled ? 1 : 0) : (patch.enabled ? 1 : 0),
    cron: patch.cron ?? existing.cron,
    timezone: patch.timezone ?? existing.timezone,
    prompt: patch.prompt ?? existing.prompt,
    target_type: patch.targetType ?? existing.targetType,
    target_id: patch.targetId ?? existing.targetId,
    working_directory: patch.workingDirectory ?? existing.workingDirectory,
    updated_at: nowIso(),
  });

  const updated = getScheduleById(id);
  if (!updated) {
    throw new Error(`更新定时任务失败: ${id}`);
  }
  return updated;
}

export function setScheduleEnabled(id: string, enabled: boolean): ScheduleRecord {
  return updateSchedule(id, { enabled });
}

export function deleteSchedule(id: string): void {
  const database = ensureDb();
  database.prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

export function createScheduleRun(scheduleId: string, plannedAt: string, startedAt = nowIso()): number {
  const database = ensureDb();
  const result = database.prepare(`
    INSERT INTO schedule_runs (
      schedule_id, planned_at, started_at, status
    ) VALUES (
      @schedule_id, @planned_at, @started_at, 'running'
    )
  `).run({
    schedule_id: scheduleId,
    planned_at: plannedAt,
    started_at: startedAt,
  });

  return Number(result.lastInsertRowid);
}

export function markScheduleRunSuccess(
  runId: number,
  scheduleId: string,
  finishedAt: string,
  resultText: string,
  outputMessageId: string | null,
): void {
  const database = ensureDb();
  const updateRun = database.prepare(`
    UPDATE schedule_runs
    SET
      finished_at = @finished_at,
      status = 'success',
      result_text = @result_text,
      output_message_id = @output_message_id
    WHERE id = @id
  `);
  const updateScheduleStmt = database.prepare(`
    UPDATE schedules
    SET
      last_run_at = @last_run_at,
      updated_at = @updated_at
    WHERE id = @id
  `);

  const tx = database.transaction(() => {
    updateRun.run({
      id: runId,
      finished_at: finishedAt,
      result_text: resultText,
      output_message_id: outputMessageId,
    });
    updateScheduleStmt.run({
      id: scheduleId,
      last_run_at: finishedAt,
      updated_at: finishedAt,
    });
  });

  tx();
}

export function markScheduleRunFailed(
  runId: number,
  finishedAt: string,
  errorMessage: string,
): void {
  const database = ensureDb();
  database.prepare(`
    UPDATE schedule_runs
    SET
      finished_at = @finished_at,
      status = 'failed',
      error_message = @error_message
    WHERE id = @id
  `).run({
    id: runId,
    finished_at: finishedAt,
    error_message: errorMessage,
  });
}

export function listScheduleRuns(scheduleId?: string, limit = 20): ScheduleRunRecord[] {
  const database = ensureDb();
  const rows = scheduleId
    ? database.prepare<[string, number], ScheduleRunRow>(`
        SELECT * FROM schedule_runs
        WHERE schedule_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(scheduleId, limit)
    : database.prepare<[number], ScheduleRunRow>(`
        SELECT * FROM schedule_runs
        ORDER BY id DESC
        LIMIT ?
      `).all(limit);
  return rows.map(normalizeScheduleRun);
}
