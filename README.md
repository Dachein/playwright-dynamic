# 🎭 Playwright-Dynamic 旗舰版

用于国内 IP 访问、动态规则提取、微信公众号抓取的 Playwright 增强服务。

---

## 📋 目录

- [一、新服务器完整部署](#一新服务器完整部署)
- [二、Cloudflare Tunnel 配置](#二cloudflare-tunnel-配置)
- [三、日常运维命令](#三日常运维命令)
- [四、接口文档](#四接口文档)
- [五、本地开发](#五本地开发)

---

## 一、新服务器完整部署

> 💡 适用于全新的 Ubuntu 服务器（推荐 Ubuntu 22.04/24.04）

### 1.1 安装 Docker

```bash
# 更新系统包
apt update && apt upgrade -y

# 安装 Docker
apt install -y docker.io

# 设置 Docker 开机自启
systemctl enable docker
systemctl start docker

# 验证安装
docker --version
```

### 1.2 配置 Docker 镜像加速器（重要！）

> ⚡ **必须配置**：国内服务器拉取 Docker Hub 镜像很慢，必须配置镜像加速器

```bash
# 创建 Docker daemon 配置目录
sudo mkdir -p /etc/docker

# 配置腾讯云镜像加速器（推荐，速度快）
sudo tee /etc/docker/daemon.json <<-'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com"
  ]
}
EOF

# 或者使用阿里云镜像加速器（需要登录阿里云获取专属地址）
# 访问：https://cr.console.aliyun.com/cn-hangzhou/instances/mirrors
# 将下面的 <YOUR_ALIYUN_MIRROR> 替换为你的专属地址
# sudo tee /etc/docker/daemon.json <<-'EOF'
# {
#   "registry-mirrors": ["https://<YOUR_ALIYUN_MIRROR>.mirror.aliyuncs.com"]
# }
# EOF

# 重启 Docker 使配置生效
sudo systemctl daemon-reload
sudo systemctl restart docker

# 验证配置是否生效
docker info | grep -A 10 "Registry Mirrors"
```

> 💡 **提示**：如果使用腾讯云服务器，推荐使用腾讯云镜像加速器 `mirror.ccs.tencentyun.com`，速度最快。

### 1.3 安装 Git（如果没有）

```bash
apt install -y git
```

### 1.4 拉取代码

```bash
cd ~
git clone https://github.com/Dachein/playwright-dynamic.git
cd playwright-dynamic
```

### 1.5 构建 Docker 镜像

```bash
docker build -t playwright-dynamic .
```

> ⏱️ 首次构建大约需要 5-10 分钟（取决于网络速度）

### 1.6 启动服务

```bash
docker run -d \
  --name playwright-dynamic \
  -e API_TOKEN=mindtalk-secret-2026 \
  --restart always \
  playwright-dynamic
```

> ⚠️ **注意**：这里故意**不映射端口**（没有 `-p 3000:3000`），因为我们将通过 Cloudflare Tunnel 来访问服务，更加安全。

### 1.7 验证服务启动

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs playwright-dynamic
```

---

## 二、Cloudflare Tunnel 配置

> 🔒 使用 Cloudflare Tunnel 可以避免开放服务器端口，更加安全

### 2.1 在 Cloudflare 创建 Tunnel

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. 进入 **Networks** → **Tunnels**
3. 点击 **Create a tunnel**
4. 选择 **Cloudflared** 类型
5. 给 Tunnel 起个名字（如 `playwright-sg`）
6. 复制生成的 Token（以 `eyJ...` 开头的长字符串）

### 2.2 在服务器启动 Tunnel

```bash
# 将下面的 <YOUR_TUNNEL_TOKEN> 替换为你的 Token
docker run -d \
  --name cf-tunnel \
  --restart always \
  --network container:playwright-dynamic \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token eyJhIjoiNTY0YTdjN2E0M2Q0ODk5NGQwMzU2OTI1MmM0NWYyY2QiLCJ0IjoiNmQ3Y2RiNDEtMWQzMS00NmI1LTgyM2ItNjFkMTY4M2RkYmU1IiwicyI6Ik1tSmxNV1UyTWpFdE0yRXhZeTAwTlRSaUxXSTBabUl0TmprME56QmlaVGcwWWpjMiJ9
```

> 💡 **关键点**：`--network container:playwright-dynamic` 让 Tunnel 与服务共享网络，这样 Tunnel 就能通过 `localhost:3000` 访问服务。

### 2.3 配置 Public Hostname

1. 回到 Cloudflare Tunnel 配置页面
2. 点击刚创建的 Tunnel
3. 进入 **Public Hostname** 或 **Hostname routes** 标签页
4. 添加路由：
   - **Subdomain**: `r`（或您想要的子域名）
   - **Domain**: `mindtalk.space`（您的域名）
   - **Service Type**: `HTTP`
   - **URL**: `localhost:3000`
5. 保存

### 2.4 验证 Tunnel

```bash
# 检查 Tunnel 容器状态
docker ps

# 检查 Tunnel 日志（应该看到 "Registered tunnel connection" 字样）
docker logs cf-tunnel

# 从外部访问验证
curl https://r.mindtalk.space/health
```

---

## 三、日常运维命令

### 3.1 查看状态

```bash
# 查看所有容器
docker ps

# 查看服务日志
docker logs playwright-dynamic

# 查看 Tunnel 日志
docker logs cf-tunnel

# 实时查看日志
docker logs -f playwright-dynamic
```

### 3.2 重启服务

```bash
# ⚠️ 必须按顺序操作！

# 1. 先停止 Tunnel
docker stop cf-tunnel

# 2. 再停止服务
docker stop playwright-dynamic

# 3. 先启动服务
docker start playwright-dynamic

# 4. 再启动 Tunnel
docker start cf-tunnel
```

### 3.3 更新代码并重新部署

```bash
# 1. 拉取最新代码
cd ~/playwright-dynamic
git pull

# 2. 停止并删除旧容器
docker stop cf-tunnel playwright-dynamic
docker rm cf-tunnel playwright-dynamic

# 3. 重新构建镜像
docker build -t playwright-dynamic .

# 4. 启动服务
docker run -d \
  --name playwright-dynamic \
  -e API_TOKEN=mindtalk-secret-2026 \
  --restart always \
  playwright-dynamic

# 5. 启动 Tunnel（替换为你的 Token）
docker run -d \
  --name cf-tunnel \
  --restart always \
  --network container:playwright-dynamic \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token <YOUR_TUNNEL_TOKEN>
```

> 💡 **提示**：更新后建议验证服务是否正常：
>
> ```bash
> # 检查容器状态
> docker ps
> ```

#

> # 查看服务日志（应该看到 Cookie 规范化日志）
>
> docker logs playwright-dynamic | grep -i cookie
>
> # 测试健康检查
>
> curl https://r.mindtalk.space/health
>
> ```
>
> ```

### 3.4 清理旧镜像（可选）

```bash
# 删除未使用的镜像，释放磁盘空间
docker image prune -f
```

---

## 四、接口文档

### GET /health

健康检查接口。

**响应：**

```json
{
  "status": "ok",
  "service": "playwright-dynamic",
  "version": "3.1",
  "engine": "playwright/chromium",
  "time": "2026-01-03T12:00:00.000Z"
}
```

---

### POST /extract

完整的网页提取接口，支持动态规则。

**请求头：**

```
Content-Type: application/json
```

**请求体：**

```json
{
  "url": "https://mp.weixin.qq.com/s/xxx",
  "token": "mindtalk-secret-2026",
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": "mp.weixin.qq.com",
      "path": "/"
    }
  ],
  "browser": {
    "userAgent": "自定义UA",
    "waitForSelector": "#js_content",
    "waitTime": 2000,
    "scrollToLoad": true
  },
  "extraction": {
    "contentSelectors": ["#js_content", "article"],
    "removeSelectors": ["script", "style", ".ad"]
  },
  "metadata": {
    "title": [{ "type": "selector", "selector": "h1", "priority": 1 }],
    "author": [{ "type": "meta", "name": "author", "priority": 1 }]
  }
}
```

> 🍪 **Cookie 规范化说明**：
>
> Playwright 要求每个 Cookie 必须有 `domain/path pair`，否则会报错：`Cookie should have a url or a domain/path pair`
>
> **服务端自动处理**：
>
> - 如果 Cookie 的 `domain` 字段为空或缺失，服务会自动从请求的 `url` 中提取 `hostname` 作为 `domain`
> - 如果 `path` 字段缺失，会自动设置为 `"/"`
> - 自动过滤无效的 Cookie（缺少 `name` 或 `value`）
>
> **示例**：
>
> ```json
> // 输入（domain 为空）
> {
>   "name": "session_id",
>   "value": "abc123",
>   "domain": ""
> }
>
> // 服务端自动规范化后（url: https://www.linkedin.com/in/xxx）
> {
>   "name": "session_id",
>   "value": "abc123",
>   "domain": "www.linkedin.com",  // ✅ 自动填充
>   "path": "/"                      // ✅ 自动添加
> }
> ```
>
> **适用接口**：`/extract`、`/screenshot`、`/pdf` 都支持自动规范化
>
> **优势**：所有调用方（ops-center、小程序、file-worker 等）都无需手动处理，服务端统一处理更健壮

**响应：**

```json
{
  "success": true,
  "markdown": "# 文章标题\n\n文章内容...",
  "metadata": {
    "title": "文章标题",
    "author": "作者名"
  },
  "stats": {
    "duration": 3500,
    "steps": {
      "navigate": 1200,
      "scroll": 800,
      "extract": 500,
      "convert": 1000
    }
  }
}
```

---

### POST /screenshot

网页截图接口，支持元素选择、区域裁剪、等待条件和内容净化。

**请求体：**

```json
{
  "url": "https://example.com",
  "fullPage": false,
  "type": "png",
  "quality": 80,
  "viewport": { "width": 800, "height": 1200 },
  "selector": "#main-content",
  "clip": { "x": 0, "y": 0, "width": 800, "height": 1067 },
  "browser": {
    "waitForSelector": "[data-loaded]",
    "waitTimeout": 15000,
    "userAgent": "Mozilla/5.0 ..."
  },
  "extraction": {
    "removeSelectors": [".ad", ".popup"]
  }
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 目标 URL（支持 `data:text/html` 格式） |
| `fullPage` | boolean | ❌ | 是否截取整页，默认 `false` |
| `type` | string | ❌ | 图片格式：`png`（默认）或 `jpeg` |
| `quality` | number | ❌ | JPEG 质量 1-100，默认 80 |
| `viewport` | object | ❌ | 视口尺寸 `{ width, height }` |
| `selector` | string | ❌ | CSS 选择器，截取特定元素 |
| `clip` | object | ❌ | 裁剪区域 `{ x, y, width, height }`，见下方说明 |
| `browser.waitForSelector` | string | ❌ | 等待指定选择器出现后再截图 |
| `browser.waitTimeout` | number | ❌ | waitForSelector 超时时间（ms），默认 15000 |
| `browser.userAgent` | string | ❌ | 自定义 User-Agent |
| `extraction.removeSelectors` | array | ❌ | 截图前移除的元素选择器列表 |

**clip 裁剪逻辑：**

- **只有 `clip`**：相对于页面左上角裁剪
- **`selector` + `clip`**：clip 坐标相对于元素左上角，自动转换为页面绝对坐标
- **只有 `selector`**：截取整个元素

**响应：**

成功时直接返回图片二进制数据（Content-Type: image/png 或 image/jpeg）

```
HTTP/1.1 200 OK
Content-Type: image/png
X-Duration-Ms: 2500

<binary image data>
```

失败时返回 JSON：

```json
{
  "success": false,
  "error": "Selector \"#main-content\" not found"
}
```

**示例：PDF 第一页缩略图（3:4 比例）**

```json
{
  "url": "data:text/html;charset=utf-8,...",
  "type": "png",
  "viewport": { "width": 800, "height": 1200 },
  "selector": "#pdf-canvas",
  "clip": { "x": 0, "y": 0, "width": 800, "height": 1067 },
  "browser": {
    "waitForSelector": "[data-rendered]",
    "waitTimeout": 20000
  }
}
```

此配置会等待 PDF.js 渲染完成（`data-rendered` 属性出现），然后截取 Canvas 元素的顶部 800×1067 区域。

---

### POST /pdf

网页导出 PDF 接口，支持内容净化。

**请求体：**

```json
{
  "url": "https://example.com",
  "token": "mindtalk-secret-2026",
  "format": "A4",
  "margin": {
    "top": "20mm",
    "bottom": "20mm",
    "left": "15mm",
    "right": "15mm"
  },
  "extraction": {
    "removeSelectors": [".ad", ".popup"]
  }
}
```

**响应：**

```json
{
  "success": true,
  "pdf": "data:application/pdf;base64,JVBERi0xLjQK...",
  "stats": {
    "duration": 3000
  }
}
```

---

### POST /content

获取网页原始 HTML（旧版兼容接口）。

**请求体：**

```json
{
  "url": "https://example.com",
  "token": "mindtalk-secret-2026"
}
```

---

## 五、本地开发

### 5.1 环境准备

```bash
cd backend-services/playwright-dynamic
npm install
npx playwright install chromium
```

### 5.2 启动开发服务

```bash
export API_TOKEN=your-secret-token
npm start
```

服务将在 `http://localhost:3000` 启动。

### 5.3 本地 Docker 测试

```bash
# 构建
npm run docker:build

# 运行
npm run docker:run
```

---

## 📝 环境变量

| 变量名      | 说明         | 默认值     |
| ----------- | ------------ | ---------- |
| `API_TOKEN` | 接口认证令牌 | 无（必填） |
| `PORT`      | 服务端口     | 3000       |

---

## 🏗️ 架构说明

```
┌─────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                         │
│                  https://r.mindtalk.space                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼ (Cloudflare Tunnel)
┌─────────────────────────────────────────────────────────────┐
│                    服务器 (新加坡)                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Docker Network (shared)                 │   │
│  │  ┌─────────────────┐    ┌─────────────────────────┐ │   │
│  │  │   cf-tunnel     │◄──►│  playwright-dynamic     │ │   │
│  │  │  (cloudflared)  │    │     (localhost:3000)    │ │   │
│  │  └─────────────────┘    └─────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ❌ 无需开放任何端口！                                       │
└─────────────────────────────────────────────────────────────┘
```

---
