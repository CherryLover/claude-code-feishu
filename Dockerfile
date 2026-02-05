FROM node:20-slim

# 安装 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev

# 复制构建产物
COPY dist/ ./dist/

# 创建非 root 用户（可选，bypassPermissions 在容器内已隔离）
# RUN useradd -m bot && chown -R bot:bot /app
# USER bot

CMD ["node", "dist/index.js"]
