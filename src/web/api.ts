import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { loadAgentsConfig } from '../agents/loader.js';
import { taskStore } from './store.js';
import { streamChat } from '../providers/index.js';
import { CreateTaskRequest, SendMessageRequest, StreamEvent, MessageBlock } from './types.js';

const app = new Hono();

app.use('/*', cors());

// 获取 Agent 列表
app.get('/api/agents', (c) => {
  const config = loadAgentsConfig();
  const agents = config.agents.map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    provider: a.provider,
    workspace: a.workspace,
  }));
  return c.json(agents);
});

// 获取任务列表
app.get('/api/tasks', (c) => {
  return c.json(taskStore.getAllTasks());
});

// 创建任务
app.post('/api/tasks', async (c) => {
  const body = await c.req.json<CreateTaskRequest>();
  if (!body.title || !body.agentId || !body.workingDirectory) {
    return c.json({ error: '缺少必要字段' }, 400);
  }
  const task = taskStore.createTask(body.title, body.agentId, body.workingDirectory);
  return c.json(task, 201);
});

// 获取任务详情
app.get('/api/tasks/:id', (c) => {
  const task = taskStore.getTask(c.req.param('id'));
  if (!task) return c.json({ error: '任务不存在' }, 404);
  const messages = taskStore.getMessages(task.id);
  return c.json({ ...task, messages });
});

// 更新任务
app.patch('/api/tasks/:id', async (c) => {
  const body = await c.req.json();
  const task = taskStore.updateTask(c.req.param('id'), body);
  if (!task) return c.json({ error: '任务不存在' }, 404);
  return c.json(task);
});

// 删除任务
app.delete('/api/tasks/:id', (c) => {
  const deleted = taskStore.deleteTask(c.req.param('id'));
  if (!deleted) return c.json({ error: '任务不存在' }, 404);
  return c.json({ success: true });
});

// 中断任务
app.post('/api/tasks/:id/stop', (c) => {
  const controller = taskStore.getAbortController(c.req.param('id'));
  if (controller) {
    controller.abort('user');
    taskStore.removeAbortController(c.req.param('id'));
  }
  return c.json({ success: true });
});

// 发送消息并获取 SSE 流
app.post('/api/tasks/:id/messages', async (c) => {
  const taskId = c.req.param('id');
  const task = taskStore.getTask(taskId);
  if (!task) return c.json({ error: '任务不存在' }, 404);

  const body = await c.req.json<SendMessageRequest>();
  if (!body.content) return c.json({ error: '消息内容不能为空' }, 400);

  // 获取 agent 配置
  const agentsConfig = loadAgentsConfig();
  const agent = agentsConfig.agents.find(a => a.id === task.agentId);
  if (!agent) return c.json({ error: 'Agent 不存在' }, 404);

  // 添加用户消息
  taskStore.addMessage(taskId, 'user', body.content);
  taskStore.updateTask(taskId, { status: 'running' });

  // 创建 AI 消息占位
  const aiMessage = taskStore.addMessage(taskId, 'assistant', '', []);
  const blocks: MessageBlock[] = [];
  let textContent = '';
  let currentThinking = '';
  let currentTool: { name: string; input: string } | null = null;
  const startTime = Date.now();

  // 设置中断控制器
  const abortController = new AbortController();
  taskStore.setAbortController(taskId, abortController);

  // 临时设置环境变量以使用正确的 provider
  const originalProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = agent.provider;

  return streamSSE(c, async (stream) => {
    const sendEvent = (event: StreamEvent) => {
      stream.writeSSE({ data: JSON.stringify(event) });
    };

    try {
      const chatStream = streamChat(body.content, task.claudeSessionId, {
        abortSignal: abortController.signal,
        workingDirectory: task.workingDirectory,
      });

      for await (const event of chatStream) {
        if (abortController.signal.aborted) {
          sendEvent({ type: 'error', message: '已中断' });
          break;
        }

        switch (event.type) {
          case 'tool_start': {
            const toolName = event.toolName || '工具';
            if (toolName === 'Reasoning') {
              currentThinking = '';
              sendEvent({ type: 'thinking_start' });
            } else {
              currentTool = { name: toolName, input: event.toolInput || '' };
              sendEvent({ type: 'tool_start', name: toolName, input: event.toolInput || '' });
            }
            break;
          }
          case 'tool_end': {
            const toolName = event.toolName || '工具';
            if (toolName === 'Reasoning') {
              if (currentThinking) {
                blocks.push({ type: 'thinking', content: currentThinking });
              }
              sendEvent({ type: 'thinking_end' });
              currentThinking = '';
            } else if (currentTool) {
              blocks.push({
                type: 'tool',
                content: '',
                toolName: currentTool.name,
                toolInput: currentTool.input,
                toolOutput: event.toolOutput || '',
              });
              sendEvent({ type: 'tool_end', name: currentTool.name, output: event.toolOutput || '' });
              currentTool = null;
            }
            break;
          }
          case 'tool_result': {
            // 思考内容通过 tool_result 传递
            if (event.toolName === 'Reasoning' && event.toolOutput) {
              currentThinking += event.toolOutput;
              sendEvent({ type: 'thinking_delta', content: event.toolOutput });
            }
            break;
          }
          case 'text': {
            if (event.content) {
              textContent += event.content;
              sendEvent({ type: 'text_delta', content: event.content });
            }
            break;
          }
          case 'result': {
            if (event.content) {
              textContent = event.content;
            }
            if (event.sessionId) {
              taskStore.updateTask(taskId, { claudeSessionId: event.sessionId });
            }
            blocks.push({ type: 'text', content: textContent });
            
            const duration = Date.now() - startTime;
            const usage = event.usage ? { input: event.usage.inputTokens, output: event.usage.outputTokens } : undefined;
            
            taskStore.updateMessage(taskId, aiMessage.id, {
              content: textContent,
              blocks,
              usage,
              duration,
            });
            taskStore.updateTask(taskId, { status: 'pending' });
            
            sendEvent({ type: 'message_done', messageId: aiMessage.id, usage, duration });
            break;
          }
          case 'error': {
            sendEvent({ type: 'error', message: event.content || '未知错误' });
            taskStore.updateTask(taskId, { status: 'pending' });
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      sendEvent({ type: 'error', message });
      taskStore.updateTask(taskId, { status: 'pending' });
    } finally {
      process.env.AI_PROVIDER = originalProvider;
      taskStore.removeAbortController(taskId);
    }
  });
});

export { app };
