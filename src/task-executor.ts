import { formatProgressCurrent } from './formatter.js';
import { streamChat } from './provider.js';
import { createTaskProgressState, TaskProgressState } from './task-progress.js';
import { ClaudeEvent, StreamChatOptions, UsageInfo } from './types.js';

export type TaskAbortReason = 'user' | 'timeout' | 'external';
export type TaskExecutionStatus = 'success' | 'error' | 'aborted';

export interface ExecuteTaskOptions extends StreamChatOptions {
  prompt: string;
  sessionId: string | null;
  timeoutMs: number;
  externalAbortReason?: TaskAbortReason | (() => TaskAbortReason);
  onProgress?: (state: TaskProgressState, event: ClaudeEvent) => Promise<void> | void;
}

export interface ExecuteTaskResult {
  status: TaskExecutionStatus;
  abortReason?: TaskAbortReason;
  content: string;
  sessionId: string | null;
  usageInfo?: UsageInfo;
  errorMessage?: string;
  progress: TaskProgressState;
}

function getAbortReason(signal: AbortSignal): TaskAbortReason {
  const reason = signal.reason;
  if (reason === 'user' || reason === 'timeout' || reason === 'external') {
    return reason;
  }
  return 'external';
}

export async function executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
  const progress = createTaskProgressState();
  let nextSessionId = options.sessionId;
  let content = '';
  let usageInfo: UsageInfo | undefined;
  let errorMessage: string | undefined;
  let status: TaskExecutionStatus = 'success';
  let abortReason: TaskAbortReason | undefined;

  const streamAbortController = new AbortController();
  const resolveExternalAbortReason = (): TaskAbortReason => {
    if (typeof options.externalAbortReason === 'function') {
      return options.externalAbortReason();
    }
    return options.externalAbortReason || 'external';
  };
  const abortStream = (reason: TaskAbortReason) => {
    if (!streamAbortController.signal.aborted) {
      streamAbortController.abort(reason);
    }
  };

  const externalAbortListener = () => {
    abortStream(resolveExternalAbortReason());
  };

  if (options.abortSignal?.aborted) {
    externalAbortListener();
  } else {
    options.abortSignal?.addEventListener('abort', externalAbortListener, { once: true });
  }

  const emitProgress = async (event: ClaudeEvent) => {
    if (options.onProgress) {
      await options.onProgress(progress, event);
    }
  };

  let timeoutTimer: NodeJS.Timeout | null = null;
  const resetTimeout = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    timeoutTimer = setTimeout(() => {
      abortStream('timeout');
    }, options.timeoutMs);
  };

  resetTimeout();

  try {
    const streamOptions: StreamChatOptions = {
      abortSignal: streamAbortController.signal,
      feishuClient: options.feishuClient,
      chatId: options.chatId,
      senderOpenId: options.senderOpenId,
      senderName: options.senderName,
      inputImages: options.inputImages,
      workingDirectory: options.workingDirectory,
    };
    const stream = streamChat(options.prompt, options.sessionId, streamOptions);

    for await (const event of stream) {
      const shouldRefreshTimeout = event.type === 'text'
        || event.type === 'result'
        || event.type === 'tool_start'
        || event.type === 'tool_end'
        || event.type === 'tool_result';
      if (shouldRefreshTimeout) {
        resetTimeout();
      }

      if (streamAbortController.signal.aborted) {
        abortReason = getAbortReason(streamAbortController.signal);
        status = 'aborted';
        progress.current = abortReason === 'timeout' ? '执行超时' : '已停止';
        await emitProgress(event);
        break;
      }

      switch (event.type) {
        case 'tool_start': {
          const toolName = event.toolName || '工具';
          if (toolName === 'Reasoning') {
            progress.reasoningCount += 1;
            progress.current = '思考中';
          } else {
            progress.toolCallCount += 1;
            progress.current = formatProgressCurrent(toolName);
          }
          await emitProgress(event);
          break;
        }
        case 'tool_end': {
          const toolName = event.toolName || '工具';
          progress.current = formatProgressCurrent(toolName, event.toolInput || '');
          await emitProgress(event);
          break;
        }
        case 'tool_result':
          await emitProgress(event);
          break;
        case 'text':
          if (!progress.answerPhaseStarted) {
            progress.answerPhaseStarted = true;
            progress.current = '整理答案';
            await emitProgress(event);
          }
          break;
        case 'result':
          if (event.sessionId) {
            nextSessionId = event.sessionId;
          }
          if (event.content) {
            content = event.content;
          }
          usageInfo = event.usage;
          progress.usageInfo = event.usage;
          progress.current = '输出完成';
          status = 'success';
          await emitProgress(event);
          break;
        case 'error':
          errorMessage = event.content || '未知错误';
          progress.current = '执行出错';
          status = 'error';
          await emitProgress(event);
          break;
      }
    }
  } catch (error: unknown) {
    if (streamAbortController.signal.aborted) {
      abortReason = getAbortReason(streamAbortController.signal);
      status = 'aborted';
      progress.current = abortReason === 'timeout' ? '执行超时' : '已停止';
    } else {
      errorMessage = error instanceof Error ? error.message : '未知错误';
      progress.current = '执行出错';
      status = 'error';
    }
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    options.abortSignal?.removeEventListener('abort', externalAbortListener);
  }

  if (streamAbortController.signal.aborted) {
    abortReason = abortReason || getAbortReason(streamAbortController.signal);
    status = 'aborted';
  } else if (status === 'success' && errorMessage) {
    status = 'error';
  }

  return {
    status,
    abortReason,
    content,
    sessionId: nextSessionId,
    usageInfo,
    errorMessage,
    progress,
  };
}
