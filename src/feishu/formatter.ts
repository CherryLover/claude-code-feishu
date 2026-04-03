const TOOL_ICONS: Record<string, string> = {
  'Bash': '🖥️ 执行命令',
  'Read': '📖 读取文件',
  'Write': '✏️ 写入文件',
  'Edit': '📝 编辑文件',
  'Grep': '🔍 搜索内容',
  'Glob': '📁 查找文件',
  'WebSearch': '🌐 网络搜索',
  'WebFetch': '🔗 获取网页',
  'Task': '🤖 子任务',
  'TodoWrite': '📋 任务列表',
  'Reasoning': '💭 思考',
  'search_user': '🔍 搜索用户',
  'send_file_to_user': '📎 发送文件',
  'send_message_to_user': '💬 发送消息',
  'create_task': '✅ 创建待办',
  'create_calendar_event': '📅 创建日程',
  'schedule_list': '🗂️ 查看定时',
  'schedule_create': '⏰ 创建定时',
  'schedule_update': '🛠️ 修改定时',
  'schedule_enable': '▶️ 启用定时',
  'schedule_disable': '⏸️ 停用定时',
  'schedule_delete': '🗑️ 删除定时',
  'schedule_run_now': '🚀 立即执行定时',
};

const SUBAGENT_ICONS: Record<string, string> = {
  'Explore': '🔍',
  'Plan': '📋',
  'Bash': '🖥️',
  'general-purpose': '🤖',
};

function truncateSingleLine(value: string, maxLen = 72): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function normalizeToolName(toolName: string): string {
  if (toolName.startsWith('MCP:')) {
    const normalized = toolName.replace(/^MCP:[^/]+\//, '');
    return normalized || toolName;
  }
  return toolName;
}

function extractScalarValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractScalarValue(item)).filter(Boolean).join(', ');
  }
  return '';
}

function getProgressSummaryFromParsed(toolName: string, parsed: any): string {
  if (toolName === 'Reasoning') {
    return '思考中';
  }
  if (toolName === 'Bash' && parsed.command) {
    return truncateSingleLine(String(parsed.command).split('\n')[0] || String(parsed.command));
  }
  if (['Read', 'Write', 'Edit'].includes(toolName) && parsed.file_path) {
    return truncateSingleLine(String(parsed.file_path));
  }
  if (toolName === 'WebSearch' && parsed.query) {
    return truncateSingleLine(String(parsed.query));
  }
  if (toolName === 'WebFetch' && parsed.url) {
    return truncateSingleLine(String(parsed.url));
  }
  if (toolName === 'Grep' && parsed.pattern) {
    return truncateSingleLine(String(parsed.pattern));
  }
  if (toolName === 'Glob' && parsed.pattern) {
    return truncateSingleLine(String(parsed.pattern));
  }
  if (toolName === 'Task') {
    const summary = parsed.description || parsed.subagent_type || parsed.prompt;
    return truncateSingleLine(String(summary || ''));
  }
  if (toolName === 'search_user' && parsed.query) {
    return truncateSingleLine(String(parsed.query));
  }
  if (toolName === 'send_message_to_user') {
    return truncateSingleLine(String(parsed.open_id || parsed.chat_id || parsed.content || ''));
  }
  if (toolName === 'send_file_to_user') {
    return truncateSingleLine(String(parsed.file_path || parsed.open_id || parsed.chat_id || ''));
  }
  if (toolName === 'create_task' && parsed.title) {
    return truncateSingleLine(String(parsed.title));
  }
  if (toolName === 'create_calendar_event' && parsed.title) {
    return truncateSingleLine(String(parsed.title));
  }
  if (toolName === 'schedule_create' && parsed.name) {
    return truncateSingleLine(String(parsed.name));
  }
  if (toolName === 'schedule_update' && parsed.id) {
    return truncateSingleLine(String(parsed.id));
  }
  if (['schedule_enable', 'schedule_disable', 'schedule_delete', 'schedule_run_now'].includes(toolName) && parsed.id) {
    return truncateSingleLine(String(parsed.id));
  }

  for (const key of ['file_path', 'path', 'command', 'query', 'pattern', 'url', 'title', 'name', 'open_id', 'chat_id']) {
    const value = extractScalarValue(parsed?.[key]);
    if (value) return truncateSingleLine(value);
  }

  return truncateSingleLine(extractScalarValue(parsed));
}

export function formatToolStart(toolName: string): string {
  if (toolName === 'Task') {
    return '';
  }
  return `**${TOOL_ICONS[toolName] || `🔧 ${toolName}`}**`;
}

export function formatToolEnd(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input);
    if (toolName === 'Bash' && parsed.command) {
      return `\`\`\`bash\n${parsed.command}\n\`\`\``;
    }
    if (['Read', 'Write', 'Edit'].includes(toolName) && parsed.file_path) {
      return `📄 \`${parsed.file_path}\``;
    }
    if (toolName === 'WebSearch' && parsed.query) {
      return `🔍 "${parsed.query}"`;
    }
    if (toolName === 'Grep' && parsed.pattern) {
      return `🔍 \`${parsed.pattern}\``;
    }
    if (toolName === 'Glob' && parsed.pattern) {
      return `📁 \`${parsed.pattern}\``;
    }
    if (toolName === 'search_user' && parsed.query) {
      return `🔍 搜索用户「${parsed.query}」`;
    }
    if (toolName === 'send_message_to_user') {
      const preview = parsed.content?.length > 50 ? parsed.content.slice(0, 50) + '...' : parsed.content;
      return `💬 发送消息给 \`${parsed.open_id}\`\n> ${preview || ''}`;
    }
    if (toolName === 'send_file_to_user') {
      const target = parsed.open_id
        ? `open_id:${parsed.open_id}`
        : (parsed.chat_id ? `chat_id:${parsed.chat_id}` : '当前聊天');
      const note = parsed.message ? `\n> ${parsed.message}` : '';
      return `📎 发送文件 \`${parsed.file_path}\` → \`${target}\`${note}`;
    }
    if (toolName === 'create_task') {
      return `✅ 创建待办「${parsed.title}」→ \`${parsed.assignee_open_id}\`${parsed.due_date ? ` | 截止: ${parsed.due_date}` : ''}`;
    }
    if (toolName === 'create_calendar_event') {
      const attendeeCount = parsed.attendee_open_ids?.length || 0;
      return `📅 创建日程「${parsed.title}」| ${parsed.start_time} | ${attendeeCount} 位参与者`;
    }
    if (toolName === 'schedule_list') {
      return '🗂️ 查看定时任务列表';
    }
    if (toolName === 'schedule_create') {
      return `⏰ 创建定时「${parsed.name}」| ${parsed.cron}${parsed.target_id ? ` | 目标: ${parsed.target_id}` : ''}`;
    }
    if (toolName === 'schedule_update') {
      const parts = [
        `🛠️ 修改定时 \`${parsed.id}\``,
        parsed.cron ? `cron: ${parsed.cron}` : '',
        parsed.name ? `name: ${parsed.name}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
    }
    if (toolName === 'schedule_enable') {
      return `▶️ 启用定时 \`${parsed.id}\``;
    }
    if (toolName === 'schedule_disable') {
      return `⏸️ 停用定时 \`${parsed.id}\``;
    }
    if (toolName === 'schedule_delete') {
      return `🗑️ 删除定时 \`${parsed.id}\``;
    }
    if (toolName === 'schedule_run_now') {
      return `🚀 立即执行定时 \`${parsed.id}\``;
    }
    if (toolName === 'Reasoning' && parsed.reasoning) {
      const text = parsed.reasoning.length > 200
        ? parsed.reasoning.slice(0, 200) + '...'
        : parsed.reasoning;
      return text;
    }
    if (toolName === 'Task' && parsed.subagent_type) {
      const icon = SUBAGENT_ICONS[parsed.subagent_type] || '🤖';
      const desc = parsed.description || '';
      let result = `${icon} **${parsed.subagent_type}**（${desc}）`;
      if (parsed.prompt) {
        const prompt = parsed.prompt.length > 150
          ? parsed.prompt.slice(0, 150) + '...'
          : parsed.prompt;
        result += `\n${prompt}`;
      }
      return result;
    }
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    return input.length > 200 ? input.slice(0, 200) + '...' : input;
  }
}

export function formatToolResult(output: string): string {
  const maxLen = 500;
  const truncated = output.length > maxLen
    ? output.slice(0, maxLen) + '\n... (输出已截断)'
    : output;
  return `\`\`\`\n${truncated}\n\`\`\``;
}

export function formatProgressCurrent(toolName: string, input?: string): string {
  const normalizedToolName = normalizeToolName(toolName);
  if (normalizedToolName === 'Reasoning') {
    return '思考中';
  }

  const summary = (() => {
    if (!input) return '';
    try {
      const parsed = JSON.parse(input);
      return getProgressSummaryFromParsed(normalizedToolName, parsed);
    } catch {
      return truncateSingleLine(input);
    }
  })();

  return summary ? `${normalizedToolName} · ${summary}` : normalizedToolName;
}

export function buildProgressCardContent(
  current: string,
  toolCallCount: number,
  reasoningCount: number,
  elapsedSeconds: number,
): string {
  return `当前：${current}\n工具调用 ${toolCallCount} 次｜思考 ${reasoningCount} 次｜耗时 ${elapsedSeconds}s`;
}

export function buildFeishuCard(title: string, content: string, copyContent?: string): string {
  const elements: any[] = [
    {
      tag: 'markdown',
      content,
    },
  ];

  if (copyContent) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '📋 复制原文' },
      type: 'default',
      size: 'small',
      behaviors: [
        {
          type: 'callback',
          value: { action: 'copy_raw' },
        },
      ],
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      title: { content: title, tag: 'plain_text' },
      template: 'blue',
    },
    body: {
      elements,
    },
  });
}
