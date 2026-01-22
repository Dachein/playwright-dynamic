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
const { exec } = require('child_process')
const { promisify } = require('util')
const fs = require('fs').promises
const path = require('path')
const os = require('os')

const execAsync = promisify(exec)

const app = express()
const PORT = process.env.PORT || 3000

// Token 认证
const API_TOKEN = process.env.API_TOKEN || 'mindtalk-secret-2026'

// Cloudflare Workers AI 配置（用于音频转录）
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID
const CF_WORKERS_AI_TOKEN = process.env.CF_WORKERS_AI_TOKEN
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo'
const MAX_WHISPER_SIZE = 25 * 1024 * 1024  // Workers AI Whisper 限制 25MB

// ============================================
// 🔄 异步转录任务存储（内存）
// ============================================
const transcriptionTasks = new Map()
// 任务状态: pending | downloading | splitting | transcribing | completed | failed
// 结构: { status, progress, message, transcript?, error?, created_at, updated_at, stats? }

// 清理过期任务（超过 1 小时）
setInterval(() => {
  const now = Date.now()
  const ONE_HOUR = 60 * 60 * 1000
  for (const [taskId, task] of transcriptionTasks) {
    if (now - task.created_at > ONE_HOUR) {
      transcriptionTasks.delete(taskId)
      console.log(`[TaskCleanup] Removed expired task: ${taskId}`)
    }
  }
}, 10 * 60 * 1000)  // 每 10 分钟清理一次

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ============================================
// 下载工具函数（超时 + 重试，针对国内服务器优化）
// ============================================
async function downloadWithRetry(url, options = {}) {
  const {
    timeout = 60000,
    maxRetries = 3,
    retryDelay = 2000
  } = options

  let lastError = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Download] Attempt ${attempt}/${maxRetries}...`)

      // 使用 AbortController 实现超时
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // 流式下载，避免一次性加载大文件到内存
      const chunks = []
      const reader = response.body.getReader()
      let receivedLength = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        receivedLength += value.length
      }

      // 合并所有 chunks
      const allChunks = new Uint8Array(receivedLength)
      let position = 0
      for (const chunk of chunks) {
        allChunks.set(chunk, position)
        position += chunk.length
      }

      console.log(`[Download] ✅ Success: ${(receivedLength / 1024 / 1024).toFixed(2)} MB`)
      return Buffer.from(allChunks)

    } catch (error) {
      lastError = error
      const isTimeout = error.name === 'AbortError' || error.message.includes('timeout')
      const isNetworkError = error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT')

      if (attempt < maxRetries && (isTimeout || isNetworkError)) {
        console.log(`[Download] ⚠️ Attempt ${attempt} failed: ${error.message}, retrying in ${retryDelay}ms...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      } else {
        throw error
      }
    }
  }

  throw lastError || new Error('Download failed after all retries')
}

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
app.get('/health', async (req, res) => {
  // 检查 FFmpeg 是否可用
  let ffmpegVersion = null
  try {
    const { stdout } = await execAsync('ffmpeg -version | head -n 1')
    ffmpegVersion = stdout.trim()
  } catch (e) {
    console.warn('[Health] ⚠️ FFmpeg not available')
  }

  res.json({
    status: 'ok',
    service: 'playwright-cn',
    version: '3.6.0',
    engine: 'playwright/chromium',
    ffmpeg: ffmpegVersion ? 'available' : 'unavailable',
    transcription: {
      min_duration: MIN_DURATION_SECONDS,
      smart_chunking: true,
      target_chunks: TARGET_CHUNK_COUNT,
      max_chunk_duration: MAX_CHUNK_DURATION,
      max_parallel: MAX_PARALLEL
    },
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
    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42',
      viewport: { width: 375, height: 812 },
      isMobile: true,
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })

    const page = await context.newPage()
    stats.setup = Date.now() - setupStart
    console.log(`[Extract] 🎭 Setup complete (+${stats.setup}ms)`)

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
    } catch (e) { }

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

      // ⏳ 先等待 waitTime（让页面充分加载，避免 bot 检测）
      const waitTime = browserConfig?.waitTime || 0
      if (waitTime > 0) {
        console.log(`[Extract] ⏳ Waiting ${waitTime}ms before JScript...`)
        await page.waitForTimeout(waitTime)
      }

      console.log('[Extract] 📜 JScript mode - executing custom script...')
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
    } catch { }

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
    } catch { }

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
// 🎧 音频切分接口（FFmpeg）
// 
// 将长音频按时间切分成多个小段，用于 Whisper 转录
// ============================================
app.post('/chunk-audio', authMiddleware, async (req, res) => {
  const {
    audio_url,           // 音频文件 URL
    chunk_duration = 120, // 每段时长（秒），默认 2 分钟
    output_format = 'mp3' // 输出格式：mp3/wav/m4a
  } = req.body

  if (!audio_url) {
    return res.status(400).json({ success: false, error: 'audio_url is required' })
  }

  console.log(`[ChunkAudio] 🎧 Starting: ${audio_url}, chunk: ${chunk_duration}s`)
  const startTime = Date.now()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-chunk-'))

  try {
    // 1. 下载音频文件（针对国内服务器优化）
    console.log(`[ChunkAudio] 📥 Downloading audio...`)
    const audioBuffer = await downloadWithRetry(audio_url, {
      timeout: 60000,
      maxRetries: 3,
      retryDelay: 2000
    })
    const inputPath = path.join(tempDir, `input.${output_format}`)
    await fs.writeFile(inputPath, audioBuffer)
    console.log(`[ChunkAudio] ✅ Downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`)

    // 2. 获取音频总时长
    const { stdout: durationOutput } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    )
    const totalDuration = parseFloat(durationOutput.trim())
    const chunkCount = Math.ceil(totalDuration / chunk_duration)

    console.log(`[ChunkAudio] 📊 Total duration: ${totalDuration.toFixed(1)}s, chunks: ${chunkCount}`)

    // 3. 切分音频
    const chunks = []
    for (let i = 0; i < chunkCount; i++) {
      const startTime = i * chunk_duration
      const outputPath = path.join(tempDir, `chunk_${i + 1}.${output_format}`)

      // FFmpeg 命令：从 startTime 开始，截取 chunk_duration 秒
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${chunk_duration} -c copy -avoid_negative_ts make_zero "${outputPath}" -y`

      try {
        await execAsync(ffmpegCmd)
        const chunkBuffer = await fs.readFile(outputPath)
        const chunkSize = chunkBuffer.length

        // 转换为 Base64（或返回 URL，这里先返回 Base64）
        const base64 = chunkBuffer.toString('base64')

        chunks.push({
          index: i + 1,
          start_time: startTime,
          duration: Math.min(chunk_duration, totalDuration - startTime),
          size: chunkSize,
          data: base64,  // Base64 编码的音频数据
          mime_type: `audio/${output_format === 'm4a' ? 'mp4' : output_format}`
        })

        console.log(`[ChunkAudio] ✅ Chunk ${i + 1}/${chunkCount}: ${(chunkSize / 1024 / 1024).toFixed(2)} MB`)
      } catch (error) {
        console.error(`[ChunkAudio] ⚠️ Failed to create chunk ${i + 1}:`, error.message)
        // 继续处理其他 chunk
      }
    }

    const duration = Date.now() - startTime
    console.log(`[ChunkAudio] 🎉 Done in ${duration}ms, ${chunks.length} chunks`)

    res.json({
      success: true,
      total_duration: totalDuration,
      chunk_duration,
      chunk_count: chunks.length,
      chunks,
      stats: {
        duration_ms: duration,
        total_size_mb: (audioBuffer.length / 1024 / 1024).toFixed(2)
      }
    })

  } catch (error) {
    console.error(`[ChunkAudio] ❌ Error:`, error)
    res.status(500).json({
      success: false,
      error: error.message,
      stats: { duration_ms: Date.now() - startTime }
    })
  } finally {
    // 清理临时文件
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (e) {
      console.warn(`[ChunkAudio] ⚠️ Failed to cleanup temp dir:`, e.message)
    }
  }
})

// ============================================
// 🎯 智能分块策略
// 
// 目标：让分块数量尽量稳定在 10 个，最大化并行效率
// 
// 规则：
// - 少于 100 分钟：动态计算，确保 ~10 个块（每块最小 2 分钟）
// - 超过 100 分钟：固定 10 分钟一块
// 
// 限制：
// - chunk_duration 上限 15 分钟 (900秒)
// - max_parallel 上限 10
// ============================================

const TARGET_CHUNK_COUNT = 10        // 目标分块数
const MIN_CHUNK_DURATION = 120       // 最小 2 分钟
const MAX_CHUNK_DURATION = 900       // 最大 15 分钟
const THRESHOLD_DURATION = 6000      // 100 分钟阈值
const LONG_AUDIO_CHUNK = 600         // 长音频固定 10 分钟
const MAX_PARALLEL = 10              // 最大并行数

/**
 * 计算最优分块时长
 * @param {number} totalDuration - 音频总时长（秒）
 * @returns {number} 分块时长（秒）
 */
function calculateOptimalChunkDuration(totalDuration) {
  if (totalDuration >= THRESHOLD_DURATION) {
    // 超过 100 分钟：固定 10 分钟一块
    return LONG_AUDIO_CHUNK
  }
  
  // 少于 100 分钟：动态计算，目标 10 个块
  let chunkDuration = Math.ceil(totalDuration / TARGET_CHUNK_COUNT)
  
  // 确保在 [2分钟, 15分钟] 范围内
  chunkDuration = Math.max(MIN_CHUNK_DURATION, chunkDuration)
  chunkDuration = Math.min(MAX_CHUNK_DURATION, chunkDuration)
  
  return chunkDuration
}

// ============================================
// 调用 Cloudflare Workers AI Whisper REST API
// ============================================
async function callWhisperAPI(base64Audio, language) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${WHISPER_MODEL}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_WORKERS_AI_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio: base64Audio,
      task: 'transcribe',
      language: language === 'auto' ? undefined : language,
      vad_filter: true  // 启用 VAD 过滤，去除静音
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Whisper API error: ${response.status} - ${errorText.slice(0, 200)}`)
  }

  const result = await response.json()

  // CF Workers AI 响应格式: { result: { text: "...", transcription_info: {...}, ... }, success: true }
  if (result.result && typeof result.result.text === 'string') {
    return result.result.text  // 即使是空字符串也返回（可能没有检测到语音）
  }
  
  // 兼容其他格式
  if (result.text) {
    return result.text
  }
  if (typeof result === 'string') {
    return result
  }

  throw new Error(`Unexpected Whisper API response format: ${JSON.stringify(result).slice(0, 200)}`)
}

// ============================================
// 🎙️ 音频转录接口
// 
// 统一入口，立即返回 task_id，后台异步处理
// - 低于 5 分钟的音频直接拒绝
// - 使用智能分块策略，自动优化分块数量
// 
// 参数限制：
// - chunk_duration: 上限 15 分钟 (不传则自动计算)
// - max_parallel: 上限 10
// ============================================
const MIN_DURATION_SECONDS = 300  // 最小时长 5 分钟

app.post('/transcribe', authMiddleware, async (req, res) => {
  const {
    audio_url,
    language = 'auto',
    chunk_duration,      // 可选：不传则使用智能分块策略
    max_parallel,        // 可选：不传则使用默认值 10
    expected_duration    // 可选：预期时长（秒），用于快速校验
  } = req.body

  if (!audio_url) {
    return res.status(400).json({ success: false, error: 'audio_url is required' })
  }

  if (!CF_ACCOUNT_ID || !CF_WORKERS_AI_TOKEN) {
    return res.status(500).json({
      success: false,
      error: 'CF_ACCOUNT_ID and CF_WORKERS_AI_TOKEN must be configured'
    })
  }

  // 如果前端传了预期时长，先快速校验
  if (expected_duration && expected_duration < MIN_DURATION_SECONDS) {
    return res.status(400).json({
      success: false,
      error: `音频时长不足 5 分钟 (${Math.floor(expected_duration / 60)}分钟)，不支持转录`,
      code: 'DURATION_TOO_SHORT'
    })
  }

  // 参数上限检查
  const safeChunkDuration = chunk_duration 
    ? Math.min(chunk_duration, MAX_CHUNK_DURATION) 
    : null  // null 表示使用智能策略
  const safeMaxParallel = Math.min(max_parallel || MAX_PARALLEL, MAX_PARALLEL)

  // 生成任务 ID
  const taskId = `trans_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()

  // 初始化任务状态
  transcriptionTasks.set(taskId, {
    status: 'pending',
    progress: 0,
    message: '任务已创建，准备开始...',
    audio_url,
    language,
    chunk_duration: safeChunkDuration,  // null 表示后续自动计算
    max_parallel: safeMaxParallel,
    created_at: now,
    updated_at: now
  })

  console.log(`[Transcribe] 🎙️ Task created: ${taskId}`)

  // 立即返回任务 ID
  res.json({
    success: true,
    task_id: taskId,
    message: '转录任务已创建'
  })

  // 后台执行转录
  executeTranscriptionTask(taskId).catch(error => {
    console.error(`[Transcribe] ❌ Task ${taskId} failed:`, error.message)
  })
})

// ============================================
// 🔍 查询异步转录任务状态
// ============================================
app.get('/transcribe-status/:task_id', authMiddleware, async (req, res) => {
  const { task_id } = req.params

  const task = transcriptionTasks.get(task_id)
  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'Task not found or expired'
    })
  }

  const response = {
    success: true,
    task_id,
    status: task.status,
    progress: task.progress,
    message: task.message,
    created_at: task.created_at,
    updated_at: task.updated_at
  }

  // 完成时返回结果
  if (task.status === 'completed') {
    response.transcript = task.transcript
    response.word_count = task.word_count
    response.stats = task.stats
  }

  // 失败时返回错误
  if (task.status === 'failed') {
    response.error = task.error
  }

  res.json(response)
})

// ============================================
// 🔧 异步转录执行函数
// ============================================
async function executeTranscriptionTask(taskId) {
  const task = transcriptionTasks.get(taskId)
  if (!task) return

  const updateTask = (updates) => {
    Object.assign(task, updates, { updated_at: Date.now() })
    transcriptionTasks.set(taskId, task)
  }

  const startTime = Date.now()
  const stats = { download: 0, probe: 0, split: 0, transcribe: 0, total: 0 }
  let tempDir = null

  try {
    // 1. 下载音频
    updateTask({ status: 'downloading', progress: 5, message: '正在下载音频文件...' })
    console.log(`[Task ${taskId}] 📥 Downloading: ${task.audio_url}`)

    const downloadStart = Date.now()
    const audioBuffer = await downloadWithRetry(task.audio_url, {
      timeout: 120000,  // 2 分钟超时（长音频文件大）
      maxRetries: 3,
      retryDelay: 3000
    })

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-async-'))
    const inputPath = path.join(tempDir, 'input.audio')
    await fs.writeFile(inputPath, audioBuffer)

    stats.download = Date.now() - downloadStart
    const fileSizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2)
    updateTask({ progress: 15, message: `下载完成 (${fileSizeMB} MB)` })
    console.log(`[Task ${taskId}] ✅ Downloaded: ${fileSizeMB} MB`)

    // 2. 获取音频时长
    const probeStart = Date.now()
    const { stdout: durationOutput } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    )
    const totalDuration = parseFloat(durationOutput.trim())
    stats.probe = Date.now() - probeStart
    console.log(`[Task ${taskId}] 📊 Duration: ${totalDuration.toFixed(1)}s`)

    // 检查最小时长
    if (totalDuration < MIN_DURATION_SECONDS) {
      throw new Error(`音频时长不足 5 分钟 (${Math.floor(totalDuration / 60)}分${Math.floor(totalDuration % 60)}秒)，不支持转录`)
    }

    // 3. 计算分块策略
    // 如果未指定 chunk_duration，使用智能分块策略
    const chunkDuration = task.chunk_duration || calculateOptimalChunkDuration(totalDuration)
    const chunkCount = Math.ceil(totalDuration / chunkDuration)
    
    console.log(`[Task ${taskId}] 📐 Chunk strategy: ${Math.floor(chunkDuration / 60)}min × ${chunkCount} chunks (total: ${Math.floor(totalDuration / 60)}min)`)

    // 4. 切分音频
    updateTask({ status: 'splitting', progress: 20, message: `正在切分音频 (${chunkCount}块)...` })
    const splitStart = Date.now()

    const chunks = []
    for (let i = 0; i < chunkCount; i++) {
      const chunkStart = i * chunkDuration
      const outputPath = path.join(tempDir, `chunk_${i}.mp3`)
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${chunkStart} -t ${chunkDuration} -vn -acodec libmp3lame -q:a 4 "${outputPath}" -y 2>/dev/null`

      try {
        await execAsync(ffmpegCmd)
        const chunkBuffer = await fs.readFile(outputPath)

        if (chunkBuffer.length <= MAX_WHISPER_SIZE) {
          chunks.push({
            index: i,
            start_time: chunkStart,
            duration: Math.min(chunkDuration, totalDuration - chunkStart),
            data: chunkBuffer.toString('base64'),
            size: chunkBuffer.length
          })
        }
      } catch (error) {
        console.warn(`[Task ${taskId}] ⚠️ Chunk ${i + 1} failed:`, error.message)
      }

      // 更新切分进度
      const splitProgress = 20 + Math.floor((i / chunkCount) * 10)
      updateTask({ progress: splitProgress, message: `切分中 ${i + 1}/${chunkCount}` })
    }

    stats.split = Date.now() - splitStart
    console.log(`[Task ${taskId}] ✅ Split: ${chunks.length} chunks`)

    // 4. 并行转录
    updateTask({ status: 'transcribing', progress: 30, message: '正在转录音频...' })
    const transcribeStart = Date.now()
    console.log(`[Task ${taskId}] 🎯 Transcribing ${chunks.length} chunks (parallel: ${task.max_parallel})`)

    const transcripts = []
    let completedChunks = 0

    for (let i = 0; i < chunks.length; i += task.max_parallel) {
      const batch = chunks.slice(i, i + task.max_parallel)

      const batchResults = await Promise.all(
        batch.map(async (chunk) => {
          try {
            const text = await callWhisperAPI(chunk.data, task.language)
            return { index: chunk.index, text, success: true }
          } catch (error) {
            console.error(`[Task ${taskId}] ❌ Chunk ${chunk.index + 1} failed:`, error.message)
            return { index: chunk.index, text: '', success: false }
          }
        })
      )

      transcripts.push(...batchResults)
      completedChunks += batch.length

      // 更新转录进度 (30% - 90%)
      const transcribeProgress = 30 + Math.floor((completedChunks / chunks.length) * 60)
      const successCount = transcripts.filter(t => t.success).length
      updateTask({
        progress: transcribeProgress,
        message: `转录中 ${completedChunks}/${chunks.length} (成功: ${successCount})`
      })
    }

    stats.transcribe = Date.now() - transcribeStart

    // 5. 拼接结果
    transcripts.sort((a, b) => a.index - b.index)
    const fullTranscript = transcripts
      .filter(t => t.text)
      .map(t => t.text.trim())
      .join('\n\n')

    const wordCount = fullTranscript.length
    const successCount = transcripts.filter(t => t.success).length
    stats.total = Date.now() - startTime

    console.log(`[Task ${taskId}] 🎉 Complete: ${wordCount} chars, ${successCount}/${chunks.length} chunks, ${stats.total}ms`)

    // 6. 标记完成
    updateTask({
      status: 'completed',
      progress: 100,
      message: '转录完成',
      transcript: fullTranscript,
      word_count: wordCount,
      stats: {
        duration_seconds: totalDuration,
        file_size_mb: parseFloat(fileSizeMB),
        chunk_duration_seconds: chunkDuration,
        chunk_count: chunks.length,
        successful_chunks: successCount,
        timing: stats
      }
    })

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Task ${taskId}] ❌ Failed:`, errorMsg)

    updateTask({
      status: 'failed',
      progress: 0,
      message: '转录失败',
      error: errorMsg
    })
  } finally {
    // 清理临时文件
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.warn(`[Task ${taskId}] ⚠️ Cleanup failed:`, e.message)
      }
    }
  }
}

// ============================================
// 🚀 启动
// ============================================
app.listen(PORT, () => {
  console.log(`
🎭 Playwright Dynamic Service v3.6
===================================
Port: ${PORT}
Token: ${API_TOKEN.substring(0, 8)}...
CF Account: ${CF_ACCOUNT_ID ? CF_ACCOUNT_ID.slice(0, 8) + '...' : 'NOT SET'}

Audio Transcription Config:
  Min Duration: ${MIN_DURATION_SECONDS / 60} min
  Smart Chunking: ~${TARGET_CHUNK_COUNT} chunks (${MIN_CHUNK_DURATION / 60}-${MAX_CHUNK_DURATION / 60} min each)
  Long Audio (≥${THRESHOLD_DURATION / 60}min): ${LONG_AUDIO_CHUNK / 60} min/chunk
  Max Parallel: ${MAX_PARALLEL}

Endpoints:
  GET  /health              - 健康检查
  POST /extract             - 🎯 动态规则提取 → Markdown
  POST /content             - 📄 只返回 HTML
  POST /screenshot          - 📸 截图 (PNG/JPEG)
  POST /pdf                 - 📑 导出 PDF (支持净化)
  POST /chunk-audio         - 🎧 音频切分（FFmpeg）
  POST /transcribe          - 🎙️ 音频转录（≥5分钟，智能分块）
  GET  /transcribe-status   - 🔍 查询转录任务状态
`)
})
