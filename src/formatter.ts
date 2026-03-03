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
};

export function formatToolStart(toolName: string): string {
  // Task 工具在 formatToolEnd 中完整输出，这里返回空
  if (toolName === 'Task') {
    return '';
  }
  return `**${TOOL_ICONS[toolName] || `🔧 ${toolName}`}**`;
}

// Task 子代理类型图标
const SUBAGENT_ICONS: Record<string, string> = {
  'Explore': '🔍',
  'Plan': '📋',
  'Bash': '🖥️',
  'general-purpose': '🤖',
};

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
    // 飞书主动交互工具
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
    // Reasoning（Codex 思考过程）
    if (toolName === 'Reasoning' && parsed.reasoning) {
      const text = parsed.reasoning.length > 200
        ? parsed.reasoning.slice(0, 200) + '...'
        : parsed.reasoning;
      return text;
    }
    // Task 工具特殊处理：🤖 Explore（描述）+ prompt
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

export function buildFeishuCard(title: string, content: string, copyContent?: string): string {
  // 使用卡片 JSON v2 格式，支持更完整的 Markdown 语法（包括表格、标题等）
  const elements: any[] = [
    {
      tag: 'markdown',
      content,
    },
  ];

  // 添加「复制原文」按钮（V2 中按钮直接放在 elements，通过回调发送纯文本）
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
