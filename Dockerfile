# 🎭 Playwright-Dynamic 旗舰版（原地筑巢版）
# 
# 不依赖海外预构建镜像，直接在国内服务器上安装
# 构建: docker build -t playwright-dynamic .
# 运行: docker run -d -p 3000:3000 -e API_TOKEN=xxx playwright-dynamic

# 1. 使用轻量级 Node 基础镜像
FROM node:20-bookworm-slim

# 2. 设置工作目录
WORKDIR /app

# 3. 换上腾讯云自家的 apt 镜像源（针对腾讯云机器优化，快如闪电）
RUN sed -i 's/deb.debian.org/mirrors.cloud.tencent.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
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
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# 4. 换上国内的 npm 镜像源
RUN npm config set registry https://registry.npmmirror.com

# 5. 复制依赖描述并安装
COPY package*.json ./
RUN npm install --omit=dev

# 6. 安装 Playwright Chromium 浏览器（走国内镜像加速）
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
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
