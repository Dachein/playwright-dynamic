# 🎭 Playwright CN 旗舰版镜像
# 
# 采用微软官方 Playwright 镜像，省去手动配置依赖的烦恼
# 构建: docker build -t playwright-cn .
# 运行: docker run -p 3000:3000 -e API_TOKEN=mindtalk-secret-2026 playwright-cn

# 使用官方 Node.js + Playwright 镜像（已内置浏览器所需的所有依赖）
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# 设置工作目录
WORKDIR /app

# 复制依赖描述文件
COPY package*.json ./

# 安装依赖（只安装生产环境需要的）
# 同时也需要安装浏览器二进制文件
RUN npm ci --only=production && \
    npx playwright install chromium

# 复制源代码
COPY src ./src

# 设置环境变量默认值
ENV PORT=3000
ENV API_TOKEN=mindtalk-secret-2026
ENV NODE_ENV=production

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["node", "src/index.js"]
