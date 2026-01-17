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
        '--disable-dev-shm-usage',
        // 🎭 反检测参数：隐藏自动化特征
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    })
  }
  return browserPromise
}

// ============================================
// 🍪 Cookie 规范化（统一处理 domain/path pair）
// ============================================
function normalizeCookies(cookies, targetUrl) {
  if (!cookies || cookies.length === 0) return []
  
  // 从 URL 提取默认 domain
  let defaultDomain = ''
  try {
    const urlObj = new URL(targetUrl)
    defaultDomain = urlObj.hostname
  } catch (e) {
    console.warn(`[Cookie] ⚠️ Cannot parse URL: ${targetUrl}`)
  }
  
  const normalized = cookies
    .filter(c => c.name && c.value) // 过滤无效 cookie
    .map(c => {
      // 如果 domain 为空，使用 URL 的 hostname
      let domain = c.domain
      if (!domain || domain.trim() === '') {
        domain = defaultDomain
      }
      // 移除开头的点（Playwright 兼容）
      if (domain && domain.startsWith('.')) {
        domain = domain.substring(1)
      }
      
      return {
        name: c.name,
        value: c.value,
        domain: domain,
        path: c.path || '/',
        expires: c.expires || -1,
        httpOnly: c.httpOnly || false,
        secure: c.secure !== undefined ? c.secure : targetUrl.startsWith('https://'),
        sameSite: c.sameSite || 'Lax'
      }
    })
    .filter(c => c.domain) // 过滤掉仍然没有 domain 的
  
  if (normalized.length > 0 && normalized.length !== cookies.length) {
    console.log(`[Cookie] 🍪 Normalized ${normalized.length}/${cookies.length} cookies → domain: ${normalized[0].domain}`)
  } else if (normalized.length > 0) {
    console.log(`[Cookie] 🍪 ${normalized.length} cookies ready for domain: ${normalized[0].domain}`)
  }
  
  return normalized
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
// 
// 支持两种提取模式:
// - dom: 传统 DOM 选择器提取（默认）
// - jscript: 自定义脚本提取（跳过 DOM 流程）
// ============================================
app.post('/extract', authMiddleware, async (req, res) => {
  const startTime = Date.now()
  const stats = { setup: 0, navigate: 0, scroll: 0, extract: 0, convert: 0, jscript: 0 }
  
  const { 
    url, 
    cookies, 
    browser: browserConfig, 
    extraction, 
    markdown: markdownConfig, 
    metadata: metadataRules,
    extractionMode,  // NEW: 'dom' | 'jscript'
    customScript     // NEW: jscript 模式时的自定义脚本
  } = req.body
  
  const mode = extractionMode || 'dom'
  
  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' })
  }
  
  console.log(`[Extract] 🚀 Playwright Starting (mode: ${mode}): ${url}`)
  
  let context = null
  
  try {
    const setupStart = Date.now()
    const browser = await getBrowser()
    
    // 🍪 规范化 cookies（确保 domain/path pair 完整）
    const normalizedCookies = normalizeCookies(cookies, url)
    
    // 🎭 创建独立的浏览器上下文 (Context)
    // YouTube 检测更严格，使用桌面版 Chrome User-Agent
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be')
    const defaultUserAgent = isYouTube 
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      : (browserConfig?.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42')
    
    context = await browser.newContext({
      userAgent: defaultUserAgent,
      viewport: isYouTube ? { width: 1920, height: 1080 } : { width: 375, height: 812 },
      isMobile: !isYouTube,
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined,
      // 🎭 隐藏自动化特征
      locale: 'en-US',
      timezoneId: 'America/New_York'
    })
    
    const page = await context.newPage()
    
    // 🎭 注入反检测脚本（必须在导航前）
    await page.addInitScript(() => {
      // 隐藏 webdriver 特征
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      // 伪造 Chrome 对象
      window.chrome = { runtime: {} }
      // 伪造权限查询
      const originalQuery = window.navigator.permissions.query
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' 
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      )
      // 伪造插件列表
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      })
      // 伪造语言列表
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      })
    })
    
    stats.setup = Date.now() - setupStart
    console.log(`[Extract] 🎭 Setup complete (+${stats.setup}ms)`)
    
    // ================================
    // 1️⃣ 导航到页面
    // ================================
    const navStart = Date.now()
    await page.goto(url, {
      waitUntil: 'commit',
      timeout: 30000
    })
    
    // 等待 domcontentloaded 或超时
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 })
    } catch (e) {}
    
    // YouTube 需要额外等待，让页面完全加载（仅 DOM 模式）
    if (isYouTube && mode === 'dom') {
      await page.waitForTimeout(2000)
    }
    
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
    // 🔀 根据模式分流处理
    // ================================
    
    if (mode === 'jscript' && customScript) {
      // ================================
      // 📜 JScript 模式：只执行自定义脚本
      // ================================
      console.log('[Extract] 📜 JScript mode - executing custom script...')
      
      // ⏱️ 使用配置的等待时间（在脚本执行前）
      const waitTime = browserConfig?.waitTime || 2000
      if (waitTime > 0) {
        console.log(`[Extract] ⏱️ Waiting ${waitTime}ms before script execution...`)
        await page.waitForTimeout(waitTime)
      }
      
      const jscriptStart = Date.now()
      
      let scriptResult = null
      try {
        scriptResult = await page.evaluate(customScript)
      } catch (e) {
        console.error('[Extract] ❌ JScript error:', e.message)
        scriptResult = { error: e.message }
      }
      
      stats.jscript = Date.now() - jscriptStart
      
      const duration = Date.now() - startTime
      console.log(`[Extract] 🎉 JScript Done in ${duration}ms`)
      
      // 如果脚本返回了完整结果，直接使用
      if (scriptResult && !scriptResult.error) {
        res.json({
          success: true,
          markdown: scriptResult.markdown || '',
          metadata: scriptResult.metadata || {},
          scriptResult: scriptResult,
          stats: {
            mode: 'jscript',
            markdownLength: (scriptResult.markdown || '').length,
            duration,
            steps: stats
          }
        })
      } else {
        // 脚本执行失败
        res.status(500).json({
          success: false,
          error: scriptResult?.error || 'JScript execution failed',
          scriptResult: scriptResult,
          stats: { mode: 'jscript', duration, steps: stats }
        })
      }
      return
    }
    
    // ================================
    // 🌐 DOM 模式：传统提取流程
    // ================================
    
    // 2️⃣ 滚动加载
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
    
    // 3️⃣ 在浏览器内执行 DOM 提取
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
    
    // 4️⃣ Markdown 转换
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
    // 📦 返回 DOM 模式结果
    // ================================
    const duration = Date.now() - startTime
    console.log(`[Extract] 🎉 DOM Done in ${duration}ms`)
    
    res.json({
      success: true,
      markdown,
      metadata: extractResult.metadata,
      stats: {
        mode: 'dom',
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
// 📸 截图接口
// ============================================
app.post('/screenshot', authMiddleware, async (req, res) => {
  const { 
    url, 
    cookies, 
    fullPage = false,        // 是否全页截图
    type = 'png',            // png 或 jpeg
    quality = 80,            // JPEG 质量 (1-100)
    selector,                // 可选：只截取某个元素
    viewport,                // 可选：自定义视口 { width, height }
    extraction,              // 可选：清理规则（净化后再截图）
    browser: browserConfig
  } = req.body
  
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' })
  
  console.log(`[Screenshot] 📸 Starting: ${url}`)
  const startTime = Date.now()
  let context = null
  
  try {
    const browser = await getBrowser()
    
    // 🍪 规范化 cookies
    const normalizedCookies = normalizeCookies(cookies, url)
    
    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      viewport: viewport || { width: 375, height: 812 },
      isMobile: !viewport,
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })
    
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    
    // 等待页面稳定
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 })
    } catch {}
    
    // 🧹 如果有清理规则，先净化页面
    if (extraction?.removeSelectors) {
      await page.evaluate((selectors) => {
        selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
      }, extraction.removeSelectors)
      console.log(`[Screenshot] 🧹 Cleaned ${extraction.removeSelectors.length} selector types`)
    }
    
    // 📸 截图
    const screenshotOptions = {
      type,
      fullPage,
      ...(type === 'jpeg' ? { quality } : {})
    }
    
    let screenshot
    if (selector) {
      // 截取特定元素
      const element = await page.$(selector)
      if (!element) {
        return res.status(400).json({ success: false, error: `Selector "${selector}" not found` })
      }
      screenshot = await element.screenshot(screenshotOptions)
    } else {
      screenshot = await page.screenshot(screenshotOptions)
    }
    
    const duration = Date.now() - startTime
    console.log(`[Screenshot] ✅ Done in ${duration}ms, size: ${screenshot.length} bytes`)
    
    res.set('Content-Type', type === 'jpeg' ? 'image/jpeg' : 'image/png')
    res.set('X-Duration-Ms', duration.toString())
    res.send(screenshot)
    
  } catch (error) {
    console.error(`[Screenshot] ❌ Error:`, error)
    res.status(500).json({ success: false, error: error.message })
  } finally {
    if (context) await context.close()
  }
})

// ============================================
// 📄 PDF 导出接口（支持净化）
// ============================================
app.post('/pdf', authMiddleware, async (req, res) => {
  const { 
    url, 
    cookies,
    format = 'A4',                    // 纸张大小：A4/Letter/Legal/Tabloid
    printBackground = true,           // 是否打印背景
    margin,                           // 页边距 { top, bottom, left, right }
    displayHeaderFooter = false,      // 是否显示页眉页脚
    headerTemplate,                   // 自定义页眉
    footerTemplate,                   // 自定义页脚
    scale = 1,                        // 缩放比例 (0.1 - 2)
    landscape = false,                // 是否横向
    extraction,                       // 🧹 清理规则（净化后再导出）
    browser: browserConfig
  } = req.body
  
  if (!url) return res.status(400).json({ success: false, error: 'URL is required' })
  
  console.log(`[PDF] 📄 Starting: ${url}`)
  const startTime = Date.now()
  let context = null
  
  try {
    const browser = await getBrowser()
    
    // 🍪 规范化 cookies
    const normalizedCookies = normalizeCookies(cookies, url)
    
    // PDF 导出建议用桌面视口
    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })
    
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    
    // 等待页面稳定
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 })
    } catch {}
    
    // 🧹 净化处理
    if (extraction) {
      // 移除不需要的元素
      if (extraction.removeSelectors?.length) {
        await page.evaluate((selectors) => {
          selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
        }, extraction.removeSelectors)
        console.log(`[PDF] 🧹 Removed elements: ${extraction.removeSelectors.join(', ')}`)
      }
      
      // 如果指定了正文选择器，只保留正文
      if (extraction.contentSelectors?.length) {
        const isolated = await page.evaluate((selectors) => {
          for (const s of selectors) {
            const el = document.querySelector(s)
            if (el && el.innerHTML.trim().length > 100) {
              // 用正文内容替换整个 body
              document.body.innerHTML = `
                <div style="max-width: 800px; margin: 0 auto; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.8;">
                  ${el.innerHTML}
                </div>
              `
              return true
            }
          }
          return false
        }, extraction.contentSelectors)
        
        if (isolated) {
          console.log(`[PDF] 🎯 Content isolated for clean PDF`)
        }
      }
      
      // 处理图片懒加载
      await page.evaluate(() => {
        document.querySelectorAll('img').forEach(img => {
          const ds = img.getAttribute('data-src') || img.getAttribute('data-original')
          if (ds) img.setAttribute('src', ds)
        })
      })
    }
    
    // 📄 生成 PDF
    const pdfOptions = {
      format,
      printBackground,
      scale,
      landscape,
      margin: margin || { top: '20px', bottom: '20px', left: '20px', right: '20px' },
      displayHeaderFooter,
      ...(headerTemplate ? { headerTemplate } : {}),
      ...(footerTemplate ? { footerTemplate } : {})
    }
    
    const pdf = await page.pdf(pdfOptions)
    
    const duration = Date.now() - startTime
    console.log(`[PDF] ✅ Done in ${duration}ms, size: ${pdf.length} bytes`)
    
    // 生成文件名
    const title = await page.title()
    const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 50) || 'document'
    
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.pdf"`)
    res.set('X-Duration-Ms', duration.toString())
    res.send(pdf)
    
  } catch (error) {
    console.error(`[PDF] ❌ Error:`, error)
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
🎭 Playwright Dynamic Service v3.1
===================================
Port: ${PORT}
Token: ${API_TOKEN.substring(0, 8)}...

Endpoints:
  GET  /health      - 健康检查
  POST /extract     - 🎯 动态规则提取 → Markdown
  POST /content     - 📄 只返回 HTML
  POST /screenshot  - 📸 截图 (PNG/JPEG)
  POST /pdf         - 📑 导出 PDF (支持净化)
`)
})
