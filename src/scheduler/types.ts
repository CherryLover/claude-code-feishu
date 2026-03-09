export type ScheduleTargetType = 'chat_id' | 'open_id';

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  prompt: string;
  targetType: ScheduleTargetType;
  targetId: string;
  workingDirectory: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunRecord {
  id: number;
  scheduleId: string;
  plannedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  resultText: string | null;
  errorMessage: string | null;
  outputMessageId: string | null;
}

export interface CreateScheduleInput {
  id: string;
  name: string;
  cron: string;
  timezone?: string;
  prompt: string;
  targetType: ScheduleTargetType;
  targetId: string;
  workingDirectory: string;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  prompt?: string;
  targetType?: ScheduleTargetType;
  targetId?: string;
  workingDirectory?: string;
}
