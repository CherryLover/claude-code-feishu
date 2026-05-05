// State
let agents = [];
let tasks = [];
let currentTask = null;
let isStreaming = false;

const API_BASE = 'http://localhost:18080';

// Router
function navigate(page, params = {}) {
  if (page === 'list') {
    currentTask = null;
    renderListPage();
  } else if (page === 'detail') {
    loadTaskDetail(params.id);
  }
}

// API
const api = {
  async get(url) {
    const res = await fetch(API_BASE + url);
    return res.json();
  },
  async post(url, data) {
    const res = await fetch(API_BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },
  async patch(url, data) {
    const res = await fetch(API_BASE + url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },
  async delete(url) {
    const res = await fetch(API_BASE + url, { method: 'DELETE' });
    return res.json();
  },
};

// Utils
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleDateString('zh-CN');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getStatusText(status) {
  return { pending: '待处理', running: '运行中', completed: '已完成' }[status] || status;
}

// Init
async function init() {
  agents = await api.get('/api/agents');
  await loadTasks();
  navigate('list');
}

async function loadTasks() {
  tasks = await api.get('/api/tasks');
}


// ========== List Page ==========
function renderListPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="header">
      <div class="logo">TASK CONSOLE</div>
      <div class="header-actions">
        <button class="btn btn-primary" onclick="openNewTaskModal()">+ 新建任务</button>
      </div>
    </div>
    <div class="page-list">
      ${renderTaskTable()}
    </div>
    ${renderNewTaskModal()}
  `;
}

function renderTaskTable() {
  if (tasks.length === 0) {
    return `
      <div class="empty-table">
        <div class="empty-table-icon">⚡</div>
        <div class="empty-table-text">暂无任务，点击「新建任务」开始</div>
      </div>
    `;
  }

  const rows = tasks.map(task => {
    const agent = agents.find(a => a.id === task.agentId);
    return `
      <tr onclick="navigate('detail', {id: '${task.id}'})">
        <td class="task-title-cell">${escapeHtml(task.title)}</td>
        <td>${agent?.name || task.agentId}</td>
        <td class="task-path">${escapeHtml(task.workingDirectory)}</td>
        <td><span class="status-badge ${task.status}">${getStatusText(task.status)}</span></td>
        <td class="time-ago">${formatTime(task.updatedAt)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="task-table">
      <thead>
        <tr>
          <th>任务</th>
          <th>Agent</th>
          <th>工作目录</th>
          <th>状态</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderNewTaskModal() {
  const agentOptions = agents.map(a => 
    `<option value="${a.id}" data-workspace="${a.workspace}">${a.name} (${a.provider})</option>`
  ).join('');
  const defaultWorkspace = agents[0]?.workspace || '';

  return `
    <div class="modal-overlay" id="newTaskModal">
      <div class="modal">
        <div class="modal-header">
          <h2>新建任务</h2>
          <button class="modal-close" onclick="closeNewTaskModal()">&times;</button>
        </div>
        <form id="newTaskForm" onsubmit="createTask(event)">
          <div class="modal-body">
            <div class="form-group">
              <label>选择 Agent</label>
              <select name="agentId" id="agentSelect" onchange="updateWorkspace()" required>${agentOptions}</select>
            </div>
            <div class="form-group">
              <label>工作目录</label>
              <input type="text" name="workingDirectory" id="workingDirectory" value="${defaultWorkspace}" required>
            </div>
            <div class="form-group">
              <label>任务描述（发送给 AI 的第一条消息）</label>
              <textarea name="prompt" placeholder="描述你要做的事情..." required></textarea>
              <div class="form-hint">创建后将立即开始执行</div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeNewTaskModal()">取消</button>
            <button type="submit" class="btn btn-primary">创建并执行</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function openNewTaskModal() {
  document.getElementById('newTaskModal').classList.add('active');
}

function closeNewTaskModal() {
  document.getElementById('newTaskModal').classList.remove('active');
}

function updateWorkspace() {
  const select = document.getElementById('agentSelect');
  const option = select.options[select.selectedIndex];
  document.getElementById('workingDirectory').value = option.dataset.workspace || '';
}

async function createTask(e) {
  e.preventDefault();
  const form = e.target;
  const prompt = form.prompt.value.trim();
  
  // 用 prompt 前 30 字作为标题
  const title = prompt.length > 30 ? prompt.slice(0, 30) + '...' : prompt;
  
  const task = await api.post('/api/tasks', {
    title,
    agentId: form.agentId.value,
    workingDirectory: form.workingDirectory.value,
  });
  
  closeNewTaskModal();
  await loadTasks();
  
  // 进入详情页并发送第一条消息
  currentTask = await api.get(`/api/tasks/${task.id}`);
  renderDetailPage();
  sendMessage(prompt);
}


// ========== Detail Page ==========
async function loadTaskDetail(taskId) {
  currentTask = await api.get(`/api/tasks/${taskId}`);
  renderDetailPage();
}

function renderDetailPage() {
  const agent = agents.find(a => a.id === currentTask.agentId);
  const app = document.getElementById('app');
  
  app.innerHTML = `
    <div class="page-detail">
      <div class="detail-header">
        <a href="#" class="back-btn" onclick="event.preventDefault(); navigate('list')">←</a>
        <div class="detail-title">${escapeHtml(currentTask.title)}</div>
        <div class="detail-meta">
          <div class="detail-meta-item">
            <span style="color:var(--text-muted)">Agent:</span>
            <span>${agent?.name || currentTask.agentId}</span>
          </div>
          <div class="detail-meta-item">
            <span style="color:var(--text-muted)">目录:</span>
            <span>${escapeHtml(currentTask.workingDirectory)}</span>
          </div>
          <div class="detail-meta-item">
            <span class="status-badge ${currentTask.status}">${getStatusText(currentTask.status)}</span>
          </div>
        </div>
        <div style="margin-left: auto; display: flex; gap: 8px;">
          <button class="btn btn-ghost" onclick="markComplete()">✓ 完成</button>
          <button class="btn btn-ghost btn-danger" onclick="deleteTask()">删除</button>
        </div>
      </div>
      <div class="conversation" id="conversation">
        ${renderConversation()}
      </div>
      <div class="input-area">
        <div class="input-wrapper">
          <textarea id="messageInput" placeholder="继续对话..." onkeydown="handleKeydown(event)"></textarea>
          <button class="btn-send" id="sendBtn" onclick="sendMessage()">发送</button>
        </div>
      </div>
    </div>
  `;
  
  scrollToBottom();
}

function renderConversation() {
  const messages = currentTask.messages || [];
  if (messages.length === 0) {
    return '<div style="padding: 40px; text-align: center; color: var(--text-muted);">等待对话开始...</div>';
  }
  
  // 按轮次分组：每个 user + 后续的 assistant 为一轮
  const turns = [];
  let currentTurn = null;
  
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { user: msg, assistant: null };
    } else if (msg.role === 'assistant' && currentTurn) {
      currentTurn.assistant = msg;
    }
  }
  if (currentTurn) turns.push(currentTurn);
  
  return turns.map((turn, i) => renderTurn(turn, i + 1)).join('');
}

function renderTurn(turn, index) {
  const userTime = formatTime(turn.user.createdAt);
  
  let assistantHtml = '';
  if (turn.assistant) {
    const blocks = turn.assistant.blocks || [];
    const steps = blocks.filter(b => b.type === 'thinking' || b.type === 'tool');
    const textBlock = blocks.find(b => b.type === 'text');
    
    // 中间步骤
    let stepsHtml = '';
    if (steps.length > 0) {
      const stepsItems = steps.map((step, i) => {
        if (step.type === 'thinking') {
          return `
            <div class="step-item thinking" onclick="toggleStep(this, event)">
              <div class="step-header">
                <span><span class="step-icon">💭</span><span class="step-name">思考</span></span>
                <span class="step-toggle">展开</span>
              </div>
              <div class="step-body">${escapeHtml(step.content)}</div>
            </div>
          `;
        } else {
          return `
            <div class="step-item tool" onclick="toggleStep(this, event)">
              <div class="step-header">
                <span><span class="step-icon">🔧</span><span class="step-name">${escapeHtml(step.toolName || '工具')}</span></span>
                <span class="step-toggle">展开</span>
              </div>
              <div class="step-body"><strong>输入:</strong>\n${escapeHtml(step.toolInput || '')}\n\n<strong>输出:</strong>\n${escapeHtml(step.toolOutput || '')}</div>
            </div>
          `;
        }
      }).join('');
      
      stepsHtml = `
        <div class="steps-container" onclick="toggleSteps(this, event)">
          <div class="steps-toggle">
            <span class="steps-toggle-icon">▶</span>
            <span>${steps.length} 个执行步骤</span>
          </div>
          <div class="steps-list">${stepsItems}</div>
        </div>
      `;
    }
    
    // AI 回复
    let responseHtml = '';
    if (textBlock && textBlock.content) {
      responseHtml = `
        <div class="ai-response">
          <div class="ai-response-label">AI 回复</div>
          <div class="ai-response-content">${marked.parse(textBlock.content)}</div>
        </div>
      `;
    }
    
    // 统计
    let statsHtml = '';
    if (turn.assistant.usage || turn.assistant.duration) {
      const parts = [];
      if (turn.assistant.duration) parts.push(`⏱️ ${(turn.assistant.duration / 1000).toFixed(1)}s`);
      if (turn.assistant.usage) parts.push(`📊 ${turn.assistant.usage.input} / ${turn.assistant.usage.output} tokens`);
      statsHtml = `<div class="turn-stats">${parts.join(' · ')}</div>`;
    }
    
    assistantHtml = stepsHtml + responseHtml + statsHtml;
  }
  
  return `
    <div class="turn-card" id="turn-${index}">
      <div class="turn-header">
        <span class="turn-label">第 ${index} 轮</span>
        <span class="turn-time">${userTime}</span>
      </div>
      <div class="turn-body">
        <div class="user-message">
          <div class="user-message-label">你</div>
          <div>${escapeHtml(turn.user.content)}</div>
        </div>
        ${assistantHtml}
      </div>
    </div>
  `;
}

function toggleSteps(container, event) {
  if (event.target.closest('.step-item')) return;
  container.classList.toggle('expanded');
}

function toggleStep(item, event) {
  event.stopPropagation();
  item.classList.toggle('expanded');
  const toggle = item.querySelector('.step-toggle');
  toggle.textContent = item.classList.contains('expanded') ? '收起' : '展开';
}


// ========== Messaging ==========
function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage(initialPrompt) {
  const input = document.getElementById('messageInput');
  const content = initialPrompt || input?.value?.trim();
  if (!content || !currentTask || isStreaming) return;
  
  if (input) input.value = '';
  isStreaming = true;
  updateSendButton();
  
  const conversation = document.getElementById('conversation');
  const turnIndex = (currentTask.messages?.filter(m => m.role === 'user').length || 0) + 1;
  
  // 添加新的轮次卡片
  conversation.innerHTML += `
    <div class="turn-card" id="turn-${turnIndex}">
      <div class="turn-header">
        <span class="turn-label">第 ${turnIndex} 轮</span>
        <span class="turn-time">刚刚</span>
      </div>
      <div class="turn-body">
        <div class="user-message">
          <div class="user-message-label">你</div>
          <div>${escapeHtml(content)}</div>
        </div>
        <div id="streaming-area">
          <div class="streaming-indicator"><span class="streaming-dot"></span>思考中...</div>
        </div>
      </div>
    </div>
  `;
  scrollToBottom();
  
  const streamingArea = document.getElementById('streaming-area');
  let steps = [];
  let currentText = '';
  let currentThinking = '';
  let currentTool = null;
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${API_BASE}/api/tasks/${currentTask.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      // SSE 格式是 "data: xxx\n\n"，按双换行分割
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch (e) {
          console.error('SSE parse error:', line);
          continue;
        }
        
        switch (event.type) {
          case 'thinking_start':
            currentThinking = '';
            if (streamingArea) streamingArea.innerHTML = renderStreamingSteps(steps, { type: 'thinking', content: '' }, null, true);
            break;
            
          case 'thinking_delta':
            currentThinking += event.content;
            if (streamingArea) streamingArea.innerHTML = renderStreamingSteps(steps, { type: 'thinking', content: currentThinking }, null, true);
            break;
            
          case 'thinking_end':
            if (currentThinking) steps.push({ type: 'thinking', content: currentThinking });
            currentThinking = '';
            if (streamingArea) streamingArea.innerHTML = renderStreamingSteps(steps, null, null, true);
            break;
            
          case 'tool_start':
            currentTool = { type: 'tool', toolName: event.name, toolInput: event.input, toolOutput: '' };
            if (streamingArea) streamingArea.innerHTML = renderStreamingSteps(steps, null, currentTool, true);
            break;
            
          case 'tool_end':
            if (currentTool) {
              currentTool.toolOutput = event.output;
              steps.push(currentTool);
            }
            currentTool = null;
            if (streamingArea) streamingArea.innerHTML = renderStreamingSteps(steps, null, null, true);
            break;
            
          case 'text_delta':
            currentText += event.content;
            if (streamingArea) {
              streamingArea.innerHTML = renderStreamingSteps(steps, null, null, false) + 
                `<div class="ai-response"><div class="ai-response-label">AI 回复</div><div class="ai-response-content">${marked.parse(currentText)}</div></div>`;
            }
            scrollToBottom();
            break;
            
          case 'message_done':
            finishStreaming(steps, currentText, event);
            break;
            
          case 'error':
            if (streamingArea) streamingArea.innerHTML += `<div style="color: var(--error); padding: 12px;">错误: ${escapeHtml(event.message)}</div>`;
            finishStreaming(steps, currentText, null);
            break;
        }
      }
    }
  } catch (err) {
    streamingArea.innerHTML += `<div style="color: var(--error); padding: 12px;">连接错误: ${err.message}</div>`;
    finishStreaming(steps, currentText, null);
  }
}

function renderStreamingSteps(completedSteps, activeThinking, activeTool, showIndicator) {
  let html = '';
  
  // 已完成的步骤（收起状态）
  if (completedSteps.length > 0) {
    const items = completedSteps.map(step => {
      if (step.type === 'thinking') {
        return `<div class="step-item thinking"><div class="step-header"><span><span class="step-icon">💭</span>思考</span><span class="step-toggle">展开</span></div><div class="step-body">${escapeHtml(step.content)}</div></div>`;
      } else {
        return `<div class="step-item tool"><div class="step-header"><span><span class="step-icon">🔧</span>${escapeHtml(step.toolName)}</span><span class="step-toggle">展开</span></div><div class="step-body"><strong>输入:</strong>\n${escapeHtml(step.toolInput)}\n\n<strong>输出:</strong>\n${escapeHtml(step.toolOutput)}</div></div>`;
      }
    }).join('');
    html += `<div class="steps-container"><div class="steps-toggle" onclick="this.parentElement.classList.toggle('expanded')"><span class="steps-toggle-icon">▶</span><span>${completedSteps.length} 个已完成步骤</span></div><div class="steps-list">${items}</div></div>`;
  }
  
  // 当前活跃的思考
  if (activeThinking) {
    html += `<div class="step-item thinking expanded" style="margin-bottom:12px"><div class="step-header"><span><span class="step-icon">💭</span>思考中...</span></div><div class="step-body" style="display:block">${escapeHtml(activeThinking.content)}</div></div>`;
  }
  
  // 当前活跃的工具
  if (activeTool) {
    html += `<div class="step-item tool expanded" style="margin-bottom:12px"><div class="step-header"><span><span class="step-icon">🔧</span>${escapeHtml(activeTool.toolName)}</span></div><div class="step-body" style="display:block"><strong>输入:</strong>\n${escapeHtml(activeTool.toolInput)}\n\n<strong>输出:</strong>\n等待中...</div></div>`;
  }
  
  // 等待指示器
  if (showIndicator && !activeThinking && !activeTool) {
    html += `<div class="streaming-indicator" style="padding:12px"><span class="streaming-dot"></span>处理中...</div>`;
  }
  
  return html;
}

function finishStreaming(steps, text, eventData) {
  isStreaming = false;
  updateSendButton();
  
  const streamingArea = document.getElementById('streaming-area');
  if (!streamingArea) return;
  
  let html = '';
  
  // 步骤（收起）
  if (steps.length > 0) {
    const items = steps.map(step => {
      if (step.type === 'thinking') {
        return `<div class="step-item thinking" onclick="toggleStep(this,event)"><div class="step-header"><span><span class="step-icon">💭</span>思考</span><span class="step-toggle">展开</span></div><div class="step-body">${escapeHtml(step.content)}</div></div>`;
      } else {
        return `<div class="step-item tool" onclick="toggleStep(this,event)"><div class="step-header"><span><span class="step-icon">🔧</span>${escapeHtml(step.toolName)}</span><span class="step-toggle">展开</span></div><div class="step-body"><strong>输入:</strong>\n${escapeHtml(step.toolInput)}\n\n<strong>输出:</strong>\n${escapeHtml(step.toolOutput)}</div></div>`;
      }
    }).join('');
    html += `<div class="steps-container" onclick="toggleSteps(this,event)"><div class="steps-toggle"><span class="steps-toggle-icon">▶</span><span>${steps.length} 个执行步骤</span></div><div class="steps-list">${items}</div></div>`;
  }
  
  // AI 回复
  if (text) {
    html += `<div class="ai-response"><div class="ai-response-label">AI 回复</div><div class="ai-response-content">${marked.parse(text)}</div></div>`;
  }
  
  // 统计
  if (eventData?.usage || eventData?.duration) {
    const parts = [];
    if (eventData.duration) parts.push(`⏱️ ${(eventData.duration / 1000).toFixed(1)}s`);
    if (eventData.usage) parts.push(`📊 ${eventData.usage.input} / ${eventData.usage.output} tokens`);
    html += `<div class="turn-stats">${parts.join(' · ')}</div>`;
  }
  
  streamingArea.innerHTML = html;
  loadTasks(); // 刷新任务列表
}

function updateSendButton() {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  if (isStreaming) {
    btn.textContent = '停止';
    btn.className = 'btn-send stop';
    btn.onclick = stopTask;
  } else {
    btn.textContent = '发送';
    btn.className = 'btn-send';
    btn.onclick = () => sendMessage();
  }
}

async function stopTask() {
  if (currentTask) {
    await api.post(`/api/tasks/${currentTask.id}/stop`);
  }
}

function scrollToBottom() {
  const conv = document.getElementById('conversation');
  if (conv) conv.scrollTop = conv.scrollHeight;
}

// Task actions
async function markComplete() {
  if (!currentTask) return;
  await api.patch(`/api/tasks/${currentTask.id}`, { status: 'completed' });
  await loadTasks();
  currentTask = await api.get(`/api/tasks/${currentTask.id}`);
  renderDetailPage();
}

async function deleteTask() {
  if (!currentTask || !confirm('确定删除此任务？')) return;
  await api.delete(`/api/tasks/${currentTask.id}`);
  await loadTasks();
  navigate('list');
}

// Start
init();
