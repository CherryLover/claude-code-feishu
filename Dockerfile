FROM node:20-slim

# 安装系统依赖（Claude Code CLI 需要 git 等工具）
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev

# 复制构建产物
COPY dist/ ./dist/

# 创建默认工作目录（即使 volume 挂载失败也不会报错）
RUN mkdir -p /workspace

# 创建非 root 用户（可选，bypassPermissions 在容器内已隔离）
# RUN useradd -m bot && chown -R bot:bot /app
# USER bot

CMD ["node", "dist/index.js"]
