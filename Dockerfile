# 🎭 Playwright-Dynamic 旗舰版
# 
# 构建: docker build -t playwright-dynamic .
# 运行: docker run -d -p 3000:3000 -e API_TOKEN=xxx playwright-dynamic

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

# 4. 复制依赖描述并安装
COPY package*.json ./
RUN npm install --omit=dev

# 5. 安装 Playwright Chromium 浏览器
RUN npx playwright install chromium

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
