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
};

export function formatToolStart(toolName: string): string {
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

export function buildFeishuCard(title: string, content: string): string {
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      title: { content: title, tag: 'plain_text' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content,
        },
      },
    ],
  });
}
