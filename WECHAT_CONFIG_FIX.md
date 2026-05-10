# 微信公众号配置修正说明

## 之前可行的场景（为何能成功）

**唯一在测试中成功的情况**：在 **本地**（localhost）运行 playwright-dynamic，使用 **最小 cookies（wxuin + mm_lang + ua_id）** + **MicroMessenger UA** + **isMobile**。

关键差异：
- **本地** = 家庭/办公室网络 IP（住宅 IP）
- **生产（reader-gz）** = 机房 IP，微信会拦截

结论：**机房 IP 下几乎不可能通过**，住宅 IP + 有效 cookies 才有机会。

## 验证入口 URL（wappoc_appmsgcaptcha）

当直接文章链接返回「环境异常」时，用户在浏览器点击「去验证」会跳转到：
```
https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=xxx&target_url=...
```

- `poc_token` 为一次性/短期令牌，**与创建时的会话绑定**
- 在你自己的浏览器中打开可访问，但在我们的 Playwright（不同 IP / cookies）中会失效
- 需要在 **url_matching.path_patterns** 中加入 `/mp/wappoc_appmsgcaptcha`，才能匹配并尝试提取

## 当前配置问题

| 项 | 当前值 | 问题 | 建议 |
|----|--------|------|------|
| contentSelectors | `["#page-content"]` | 公众号正文在 `#js_content`，`#page-content` 可能为空 | `["#js_content", "#page-content", "article", "body"]` |
| waitTime | 100 | 太短，页面可能未渲染完 | 2000 |
| publish_date selector | `#publish_time\t` | `\t` 导致选择器无效 | `#publish_time` |
| description selector | `#js_content p:first-of-type\t` | 同上 | `#js_content p:first-of-type` |
| cookies | 20+ 含 slave_* | 可能跨账号冲突 | 先试最小 3 个 |

## 建议修改的 browser_config 片段

```json
"browser_config": {
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2d) NetType/WIFI Language/zh_CN",
  "isMobile": true,
  "waitForSelector": "#activity-name",
  "waitTime": 2000,
  "scrollToLoad": false,
  "browserNodeUrl": "https://reader-gz.mindtalk.space",
  "contentSelectors": ["#js_content", "#page-content", "article", "body"],
  "removeSelectors": ["script", "style", "iframe", "nav", "footer"],
  "simulateHumanBehavior": true,
  "cookies": [
    {"name": "wxuin", "value": "66057293995115", "domain": "", "path": "/"},
    {"name": "mm_lang", "value": "zh_CN", "domain": "", "path": "/"},
    {"name": "ua_id", "value": "ggoGlJyGPLxkKPdzAAAAAOk662DLN4zv3VbCZw-X04g=", "domain": "", "path": "/"}
  ]
}
```

## meta_extraction 修正（去掉 \t）

```json
"custom_selectors": {
  "publish_date": ["#publish_time"],
  "description": ["#js_content p:first-of-type"]
}
```

（title/author/publisher 保持不变）

## 支持 wappoc 验证入口 URL

在 `url_matching.path_patterns` 中增加验证页路径，让分享的「去验证」链接也能被识别：

```json
"url_matching": {
  "domains": ["mp.weixin.qq.com"],
  "include_subdomains": true,
  "path_patterns": ["/s", "/mp/wappoc_appmsgcaptcha"]
}
```

## 生产环境可行方案

1. **住宅 IP 节点**：将 playwright-dynamic 部署在住宅代理或家用网络（如 cloudflared tunnel），让 WeChat 请求走住宅 IP。
2. **本地节点**：在可访问公众号的机器上跑 playwright-dynamic，通过 tunnel 暴露给生产。
3. **用户侧验证**：产品上引导用户「在微信内打开并分享」，或提供「复制验证后链接」的说明（poc_token 时效短，需尽快提交）。
