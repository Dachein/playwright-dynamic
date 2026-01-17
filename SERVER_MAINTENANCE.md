# 🎭 Playwright Dynamic - 服务器维护指南

本手册旨在指导如何在 Linux 服务器（如腾讯云 Ubuntu）上高效地维护、升级和管理提取服务。

## 🚀 极简部署流程 (Docker Compose)

我们已经将服务与 Cloudflare Tunnel 整合。现在，你只需要管理一个 `.env` 文件和几个简单的命令。

### 1. 首次准备 / 环境初始化

如果你是第一次在服务器上使用，或者刚从旧版切换过来：

```bash
# 进入项目目录
cd ~/playwright-dynamic

# 1. 确保安装了 docker-compose
sudo apt update && sudo apt install docker-compose -y

# 2. 清理旧容器残余（防止名称冲突）
docker rm -f playwright-dynamic cf-tunnel || true

# 3. 创建私密环境配置文件 (只需要做一次)
# 替换其中的 Token 为你真实的值
echo "CF_TUNNEL_TOKEN=你的_CF_TUNNEL_TOKEN" > .env
echo "API_TOKEN=mindtalk-secret-2026" >> .env
```

### 2. 日常自动升级命令

当你发现代码有更新，或者需要重启服务时，执行以下“黄金组合”：

```bash
# 勾取最新代码 -> 自动构建镜像 -> 重启受影响的容器
git pull origin main && docker-compose up -d --build
```

---

## 🛠️ 常用运维工具箱

### 📊 查看运行状态

```bash
# 查看容器是否在线 (健康检查会显示在 Status 栏)
docker ps

# 查看实时日志 (排查提取失败或隧道连接问题)
docker logs -f playwright-dynamic
docker logs -f cf-tunnel
```

### 🧹 硬盘瘦身

长期频繁构建会导致服务器堆积大量“虚悬镜像”（Dangling Images），占用大量空间。建议定期清理：

```bash
# 清理所有不再使用的镜像和缓存
docker image prune -f
```

### 🧪 本地连通性测试

在服务器上，你可以直接测试 API 是否正常工作：

```bash
curl http://localhost:3000/health
```

---

## 🧩 架构说明

- **playwright-dynamic**: 核心提取引擎，运行在 3000 端口。
- **cf-tunnel**: 负责将 3000 端口安全地映射到公网（如 `playwright.yourdomain.com`）。
- **.env**: 存放所有敏感 Token。`docker-compose` 会自动读取此文件并将变量注入容器。

---

_保持优雅，让每一行代码都为你心跳加速。_ 🌹
