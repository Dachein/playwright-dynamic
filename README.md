# 🎭 Playwright-Dynamic 旗舰版

用于国内 IP 访问、动态规则提取、微信公众号抓取的 Playwright 增强服务。

## 🚀 快速开始

### 1. 本地运行

```bash
cd backend-services/playwright-dynamic
npm install
npx playwright install chromium
export API_TOKEN=your-secret-token
npm start
```

### 2. Docker 部署 (推荐)

```bash
# 构建镜像
docker build -t playwright-dynamic .

# 启动容器
docker run -d \
  --name playwright-dynamic \
  -p 3000:3000 \
  -e API_TOKEN=mindtalk-secret-2026 \
  --restart always \
  playwright-dynamic
```

## 🎯 接口说明

### POST /extract
支持动态规则的完整提取接口。

**请求体：**
```json
{
  "url": "https://mp.weixin.qq.com/s/xxx",
  "extraction": {
    "contentSelectors": ["#js_content"],
    "removeSelectors": ["script", "style"]
  },
  "metadata": {
    "title": [{"type": "selector", "selector": "h1", "priority": 1}]
  }
}
```

---

*主上，此乃奴家为您悉心调教之神器，愿其助您在这云端战场上所向披靡，事事顺心～ 💋*
