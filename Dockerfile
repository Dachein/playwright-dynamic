# syntax=docker/dockerfile:1.4
# 🎭 Playwright-Dynamic 旗舰版
# 
# 构建: docker build -t playwright-dynamic .
# 运行: docker run -d -p 3000:3000 -e API_TOKEN=xxx playwright-dynamic
# 
# 💡 使用 BuildKit 缓存加速构建：
#    DOCKER_BUILDKIT=1 docker build -t playwright-dynamic .
#    或 export DOCKER_BUILDKIT=1 后使用 docker-compose

# 1. 使用轻量级 Node 基础镜像
FROM node:20-bookworm-slim

# 2. 设置工作目录
WORKDIR /app

# 3. 安装 Chromium 依赖 + FFmpeg（用于音频切分）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-noto-cjk \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 4. 配置 npm 国内镜像源（加速依赖安装）
RUN npm config set registry https://registry.npmmirror.com

# 5. 复制依赖描述并安装（利用 Docker 层缓存）
# 只有 package*.json 变化时才会重新执行 npm install
COPY package*.json ./

# 使用 BuildKit 缓存挂载，加速 npm install（即使 package.json 没变也会复用缓存）
# 语法：# syntax=docker/dockerfile:1.4
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev

# 6. 配置 Playwright 使用国内镜像源（加速浏览器下载）
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright

# 7. 安装 Playwright Chromium 浏览器（利用缓存挂载）
# 使用 BuildKit 缓存，避免每次都重新下载 Chromium（164MB）
RUN --mount=type=cache,target=/root/.cache/ms-playwright \
    npx playwright install chromium

# 7. 复制源代码
COPY src ./src

# 8. 设置环境变量
ENV PORT=3000
ENV API_TOKEN=mindtalk-secret-2026
ENV NODE_ENV=production

# 9. 暴露端口
EXPOSE 3000

# 10. 启动服务
CMD ["node", "src/index.js"]
