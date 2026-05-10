# 微信公众号 KV 配置与 Cookie 冲突分析

## 1. Cookie 必须性

- 微信公众号文章在未登录或异常环境下会返回「环境异常」页面
- 当前 KV 中已配置 20+ cookies，**带入 cookie 是必须的**
- `normalizeCookies` 会过滤 `value` 为空的 cookie（如 `rewardsn`）

## 2. 潜在冲突点

### 2.1 账号绑定类（slave_* / bizuin）

| Cookie        | 值              | 说明 |
|---------------|-----------------|------|
| slave_user    | gh_fe3fc2c911da | 绑定到特定公众号 |
| slave_bizuin  | 3612738250      | 业务账号 ID |
| data_bizuin   | 3612738250      | 同上 |
| bizuin        | 3612738250      | 同上 |
| slave_sid     | NENrRTF...      | 会话 ID，可能绑定 IP/账号 |

**冲突假设**：当访问的链接 `__biz` 与 cookie 中的 bizuin 不一致时，微信可能认为「跨账号访问」而返回环境异常。

- 测试 URL `__biz=MjM5NDE1MDU0MA==`（base64）对应账号与 `3612738250` 可能不同
- **建议**：用「无 slave_* cookies」组合测试，验证是否因账号绑定导致冲突

### 2.2 第三方 / 无关 cookie

| Cookie             | 说明 |
|--------------------|------|
| _hp2_id.1405110977  | Heap 分析，与微信无关，建议移除 |
| rewardsn            | 空值，已被过滤 |

### 2.3 会话类（短生命周期）

| Cookie      | 说明 |
|-------------|------|
| data_ticket | 会话票据，可能绑定 IP |
| slave_sid   | 同上 |
| poc_sid     | 同上 |

这些 cookie 过期或 IP 变化后可能失效，需定期更新。

## 3. KV 配置中的其他问题

### 3.1 选择器 typo

```json
"#publish_time\t"           // 多了 \t，应为 "#publish_time"
"#js_content p:first-of-type\t"  // 同上，应为 "#js_content p:first-of-type"
```

`playwright_rules.metadata.publishDate` 和 `description` 中存在上述错误。

### 3.2 contentSelectors

- 当前：`["#page-content"]`
- 微信公众号正文通常用 `#js_content`
- **建议**：改为 `["#js_content", "#page-content", "article", "body"]`，优先 `#js_content`

### 3.3 waitTime

- 当前：`100` ms 偏短
- **建议**：`2000` 或以上

### 3.4 userAgent

- 当前：空（默认 Chrome 桌面）
- **建议**：使用 MicroMessenger UA，更贴近微信内打开场景

## 4. 测试脚本

已更新 `scripts/test-wechat-params.js`，包含：

1. 无 cookies + Chrome 桌面（基线）
2. 无 cookies + MicroMessenger
3. **最小 cookies**（3 个：wxuin, mm_lang, ua_id）+ MicroMessenger
4. **无 slave_* cookies** + MicroMessenger（排查账号绑定冲突）
5. 完整 cookies + MicroMessenger
6. 完整 cookies + Chrome 桌面
7. 完整 cookies + waitTime 5000

运行：

```bash
cd backend-services/playwright-dynamic
node scripts/test-wechat-params.js
```

或指定 API：

```bash
API_BASE=https://reader-gz.mindtalk.space node scripts/test-wechat-params.js
```

## 5. 建议的 KV 修改

1. **Cookie**：先尝试「无 slave_*」组合；若仍异常，再试「最小 cookies」
2. **选择器**：修正 `#publish_time\t` 和 `#js_content p:first-of-type\t` 的 typo
3. **contentSelectors**：`["#js_content", "#page-content", "article", "body"]`
4. **browser_config**：`userAgent` 设为 MicroMessenger，`waitTime` 设为 2000
5. **移除**：`_hp2_id.1405110977`（第三方分析 cookie）
6. **simulateHumanBehavior**：`true` — 模拟人类等待、鼠标移动、滚动，降低自动化指纹识别
