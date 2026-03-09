import { buildProgressCardContent } from './formatter.js';
import { formatUsageInfo } from './feishu-messages.js';
import { UsageInfo } from './types.js';

export interface TaskProgressState {
  current: string;
  toolCallCount: number;
  reasoningCount: number;
  startedAt: number;
  answerPhaseStarted: boolean;
  usageInfo?: UsageInfo;
}

export function createTaskProgressState(current = '准备中'): TaskProgressState {
  return {
    current,
    toolCallCount: 0,
    reasoningCount: 0,
    startedAt: Date.now(),
    answerPhaseStarted: false,
  };
}

export function renderTaskProgressMarkdown(
  state: TaskProgressState,
  includeUsage = true,
): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  let content = buildProgressCardContent(
    state.current,
    state.toolCallCount,
    state.reasoningCount,
    elapsedSeconds,
  );

  if (includeUsage && state.usageInfo) {
    content += formatUsageInfo(state.usageInfo);
  }

  return content;
}
