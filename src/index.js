/**
 * 🚀 国内 Playwright 服务 (旗舰版)
 * 
 * 使用 Playwright 驱动的动态规则提取服务
 * 
 * 部署方式：
 * 1. 腾讯云/阿里云轻量服务器
 * 2. Docker 容器部署
 * 
 * 接口：
 * - GET  /health   - 健康检查
 * - POST /extract  - 🎯 带规则的完整提取（推荐）
 * - POST /content  - 📄 只返回渲染后的 HTML（向后兼容）
 */

const express = require('express')
const { chromium } = require('playwright')
const TurndownService = require('turndown')
const cors = require('cors')

const app = express()
const PORT = process.env.PORT || 3000

// Token 认证
const API_TOKEN = process.env.API_TOKEN || 'mindtalk-secret-2026'

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ============================================
// 🔐 认证中间件
// ============================================
function authMiddleware(req, res, next) {
  const token = req.query.token || req.headers['x-api-token']
  
  if (token !== API_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

// 全局浏览器实例（长连接，提高性能）
let browserPromise = null
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    })
  }
  return browserPromise
}

// ============================================
// 📊 健康检查
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'playwright-cn',
    version: '3.0.0',
    engine: 'playwright/chromium',
    time: new Date().toISOString()
  })
})

// ============================================
// 🎯 核心提取接口（Playwright 版）
// ============================================
app.post('/extract', authMiddleware, async (req, res) => {
  const startTime = Date.now()
  const stats = { navigate: 0, scroll: 0, extract: 0, convert: 0 }
  
  const { url, cookies, browser: browserConfig, extraction, markdown: markdownConfig, metadata: metadataRules } = req.body
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' })
  }
  
  console.log(`[Extract] 🚀 Playwright Starting: ${url}`)
  
  let context = null
  
  try {
    const browser = await getBrowser()
    
    // 🎭 创建独立的浏览器上下文 (Context) - 比 Puppeteer 更轻量
    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42',
      viewport: { width: 375, height: 812 },
      isMobile: true,
      // 注入 Cookie
      storageState: cookies && cookies.length > 0 ? {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: c.expires || -1,
          httpOnly: c.httpOnly || false,
          secure: c.secure || false,
          sameSite: c.sameSite || 'Lax'
        }))
      } : undefined
    })
    
    const page = await context.newPage()
    
    // ================================
    // 1️⃣ 导航到页面
    // ================================
    const navStart = Date.now()
    await page.goto(url, {
      waitUntil: 'commit', // 相比 domcontentloaded 更快一点点
      timeout: 30000
    })
    
    // 等待 domcontentloaded 或超时
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 })
    } catch (e) {}
    
    stats.navigate = Date.now() - navStart
    console.log(`[Extract] ✅ Navigation complete (+${stats.navigate}ms)`)
    
    // 等待特定选择器
    const waitSelector = browserConfig?.waitForSelector || 'body'
    try {
      await page.waitForSelector(waitSelector, { state: 'attached', timeout: 5000 })
    } catch (e) {
      console.log(`[Extract] ⚠️ Selector "${waitSelector}" not found`)
    }
    
    // ================================
    // 2️⃣ 滚动加载
    // ================================
    const scrollStart = Date.now()
    if (browserConfig?.scrollToLoad !== false) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let totalHeight = 0
          const distance = 400
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight
            window.scrollBy(0, distance)
            totalHeight += distance
            if (totalHeight >= scrollHeight || totalHeight > 10000) {
              clearInterval(timer)
              resolve()
            }
          }, 100)
          setTimeout(() => { clearInterval(timer); resolve() }, 4000)
        })
        window.scrollTo(0, 0)
      })
    }
    
    if (browserConfig?.waitTime) {
      await page.waitForTimeout(browserConfig.waitTime)
    }
    stats.scroll = Date.now() - scrollStart
    
    // ================================
    // 3️⃣ 在浏览器内执行提取
    // ================================
    const extractStart = Date.now()
    
    const extractionRules = extraction || {
      contentSelectors: ['article', 'main', '.content', '.post', 'body'],
      removeSelectors: ['script', 'style', 'iframe', 'nav', 'footer', '.ads', '.ad-container', 'noscript']
    }
    
    const extractResult = await page.evaluate((args) => {
      const { rules, metaRules } = args
      const result = { html: '', metadata: {} }
      
      // 🧼 清理
      if (rules.removeSelectors) {
        rules.removeSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
      }
      
      // 📋 Metadata
      const extractMeta = (fieldRules) => {
        if (!fieldRules || !Array.isArray(fieldRules)) return null
        const sorted = [...fieldRules].sort((a, b) => (a.priority || 99) - (b.priority || 99))
        for (const rule of sorted) {
          let v = null
          if (rule.type === 'meta') {
            const el = rule.property ? document.querySelector(`meta[property="${rule.property}"]`) : document.querySelector(`meta[name="${rule.name}"]`)
            v = el?.getAttribute('content')
          } else if (rule.type === 'selector') {
            const el = document.querySelector(rule.selector)
            v = el ? (rule.attribute ? el.getAttribute(rule.attribute) : el.textContent) : null
          }
          if (v && v.trim()) {
            v = v.trim()
            if (rule.transform === 'date') {
              const m = v.match(/(\d{4}[年\-/]\d{1,2}[月\-/]\d{1,2}[日]?)/)
              if (m) v = m[1]
            }
            return v
          }
        }
        return null
      }
      
      if (metaRules) {
        result.metadata = {
          title: extractMeta(metaRules.title) || document.title,
          author: extractMeta(metaRules.author),
          publisher: extractMeta(metaRules.publisher),
          publishDate: extractMeta(metaRules.publishDate),
          thumbnail: extractMeta(metaRules.thumbnail),
          description: extractMeta(metaRules.description)
        }
      } else {
        result.metadata = { title: document.title }
      }
      
      // 🥩 正文
      let targetEl = null
      for (const s of rules.contentSelectors) {
        const el = document.querySelector(s)
        if (el && el.innerText?.trim().length > 100) { targetEl = el; break }
      }
      if (!targetEl) targetEl = document.body
      
      // 处理图片
      targetEl.querySelectorAll('img').forEach(img => {
        const ds = img.getAttribute('data-src') || img.getAttribute('data-original')
        if (ds) img.setAttribute('src', ds)
      })
      
      result.html = targetEl.innerHTML
      return result
    }, { rules: extractionRules, metaRules: metadataRules })
    
    stats.extract = Date.now() - extractStart
    
    // ================================
    // 4️⃣ Markdown 转换
    // ================================
    const convertStart = Date.now()
    const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' })
    turndownService.remove(['script', 'style', 'noscript', 'iframe'])
    
    const imageAttr = markdownConfig?.imageAttribute || 'src'
    if (imageAttr !== 'src') {
      turndownService.addRule('customImage', {
        filter: 'img',
        replacement: (c, n) => {
          const src = n.getAttribute(imageAttr) || n.getAttribute('src') || ''
          const alt = n.getAttribute('alt') || ''
          return src && !src.startsWith('data:') ? `![${alt}](${src})` : ''
        }
      })
    }
    
    let markdown = turndownService.turndown(extractResult.html)
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
    stats.convert = Date.now() - convertStart
    
    // ================================
    // 📦 返回
    // ================================
    const duration = Date.now() - startTime
    console.log(`[Extract] 🎉 Playwright Done in ${duration}ms`)
    
    res.json({
      success: true,
      markdown,
      metadata: extractResult.metadata,
      stats: {
        htmlLength: extractResult.html.length,
        markdownLength: markdown.length,
        duration,
        steps: stats
      }
    })
    
  } catch (error) {
    console.error(`[Extract] ❌ Playwright Error:`, error)
    res.status(500).json({ success: false, error: error.message, stats: { duration: Date.now() - startTime, steps: stats } })
  } finally {
    if (context) await context.close()
  }
})

// ============================================
// 📄 向后兼容：只返回 HTML
// ============================================
app.post('/content', authMiddleware, async (req, res) => {
  const { url, cookies, userAgent } = req.body
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' })
  
  let context = null
  try {
    const browser = await getBrowser()
    context = await browser.newContext({
      userAgent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()
    if (cookies) await context.addCookies(cookies)
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const html = await page.content()
    
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  } finally {
    if (context) await context.close()
  }
})

// ============================================
// 🚀 启动
// ============================================
app.listen(PORT, () => {
  console.log(`
🎭 Playwright CN Service v3.0
=============================
Port: ${PORT}
Token: ${API_TOKEN.substring(0, 8)}...

Endpoints:
  GET  /health      - 健康检查
  POST /extract     - 🎯 动态规则提取
  POST /content     - 只返回 HTML
`)
})
