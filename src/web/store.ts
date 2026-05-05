import { Task, Message, MessageBlock, TaskStatus } from './types.js';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class TaskStore {
  private tasks = new Map<string, Task>();
  private messages = new Map<string, Message[]>();
  private abortControllers = new Map<string, AbortController>();

  createTask(title: string, agentId: string, workingDirectory: string): Task {
    const task: Task = {
      id: generateId(),
      title,
      agentId,
      workingDirectory,
      status: 'pending',
      claudeSessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.messages.set(task.id, []);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateTask(id: string, updates: Partial<Pick<Task, 'title' | 'status' | 'agentId' | 'workingDirectory' | 'claudeSessionId'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: Date.now() });
    return task;
  }

  deleteTask(id: string): boolean {
    this.messages.delete(id);
    this.abortControllers.delete(id);
    return this.tasks.delete(id);
  }

  getMessages(taskId: string): Message[] {
    return this.messages.get(taskId) || [];
  }

  addMessage(taskId: string, role: 'user' | 'assistant', content: string, blocks: MessageBlock[] = []): Message {
    const message: Message = {
      id: generateId(),
      taskId,
      role,
      content,
      blocks,
      createdAt: Date.now(),
    };
    const taskMessages = this.messages.get(taskId);
    if (taskMessages) {
      taskMessages.push(message);
    }
    return message;
  }

  updateMessage(taskId: string, messageId: string, updates: Partial<Pick<Message, 'content' | 'blocks' | 'usage' | 'duration'>>): Message | undefined {
    const taskMessages = this.messages.get(taskId);
    if (!taskMessages) return undefined;
    const message = taskMessages.find(m => m.id === messageId);
    if (!message) return undefined;
    Object.assign(message, updates);
    return message;
  }

  setAbortController(taskId: string, controller: AbortController): void {
    this.abortControllers.set(taskId, controller);
  }

  getAbortController(taskId: string): AbortController | undefined {
    return this.abortControllers.get(taskId);
  }

  removeAbortController(taskId: string): void {
    this.abortControllers.delete(taskId);
  }
}

export const taskStore = new TaskStore();
