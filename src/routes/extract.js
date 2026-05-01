/**
 * 🎯 Extract 路由（内容提取）
 */

const TurndownService = require('turndown')

/** 随机延迟 ms */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 模拟人类行为：等待、鼠标移动、滚动 */
async function simulateHumanBehavior(page, viewport, opts = {}) {
  const { isMobile = false } = opts
  const w = viewport?.width || 375
  const h = viewport?.height || 812

  // 1. 初始随机等待（模拟用户看到页面后的停顿）
  const initDelay = randomDelay(800, 1500)
  console.log(`[Extract] 🎭 simulateHumanBehavior: init delay ${initDelay}ms`)
  await page.waitForTimeout(initDelay)

  // 2. 在页面内 dispatch 模拟事件（补充 Playwright 可能漏掉的指纹）
  await page.evaluate(() => {
    const centerX = window.innerWidth / 2 + (Math.random() - 0.5) * 80
    const centerY = window.innerHeight / 2 + (Math.random() - 0.5) * 60
    const el = document.elementFromPoint(centerX, centerY) || document.body

    const opts = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new MouseEvent('mousemove', { ...opts, clientX: centerX, clientY: centerY }))
    el.dispatchEvent(new MouseEvent('mouseover', { ...opts, clientX: centerX, clientY: centerY }))
  })

  await page.waitForTimeout(randomDelay(200, 400))

  // 3. 人类化滚动：小步长 + 随机间隔
  await page.evaluate(async () => {
    const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    let y = 0
    const maxScroll = Math.min(document.body.scrollHeight, 3000)
    while (y < maxScroll) {
      const step = rand(80, 180)
      window.scrollBy(0, step)
      y += step
      await sleep(rand(80, 200))
    }
    window.scrollTo(0, 0)
    await sleep(rand(300, 600))
  })

  await page.waitForTimeout(randomDelay(300, 600))
  console.log('[Extract] 🎭 simulateHumanBehavior done')
}

async function extractHandler(req, res, { getBrowser, normalizeCookies }) {
  const startTime = Date.now()
  const stats = { setup: 0, navigate: 0, scroll: 0, extract: 0, convert: 0, jscript: 0 }

  const {
    url,
    cookies,
    browser: browserConfig,
    extraction,
    markdown: markdownConfig,
    metadata: metadataRules,
    extractionMode,
    customScript
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

    const normalizedCookies = normalizeCookies(cookies, url)

    const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    const userAgent = browserConfig?.userAgent || defaultUA
    const isMobile = browserConfig?.isMobile ?? false

    context = await browser.newContext({
      userAgent,
      viewport: isMobile ? { width: 375, height: 812 } : { width: 1920, height: 1080 },
      isMobile,
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ]
      })
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'zh-CN', 'zh']
      })
      if (!window.chrome) {
        window.chrome = { runtime: {} }
      }
    })

    const page = await context.newPage()
    stats.setup = Date.now() - setupStart
    console.log(`[Extract] 🎭 Setup complete (+${stats.setup}ms)`)

    const navStart = Date.now()
    await page.goto(url, {
      waitUntil: 'commit',
      timeout: 30000
    })

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 })
    } catch (e) { }

    stats.navigate = Date.now() - navStart
    console.log(`[Extract] ✅ Navigation complete (+${stats.navigate}ms)`)

    const waitSelector = browserConfig?.waitForSelector || 'body'
    try {
      await page.waitForSelector(waitSelector, { state: 'attached', timeout: 5000 })
    } catch (e) {
      console.log(`[Extract] ⚠️ Selector "${waitSelector}" not found`)
    }

    // 模拟人类行为（降低自动化指纹识别）
    if (browserConfig?.simulateHumanBehavior) {
      const viewport = isMobile ? { width: 375, height: 812 } : { width: 1920, height: 1080 }
      await simulateHumanBehavior(page, viewport, { isMobile })
    }

    // JScript 模式
    if (mode === 'jscript' && customScript) {
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
        res.status(500).json({
          success: false,
          error: scriptResult?.error || 'JScript execution failed',
          scriptResult: scriptResult,
          stats: { mode: 'jscript', duration, steps: stats }
        })
      }
      return
    }

    // DOM 模式
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

    const extractStart = Date.now()

    const extractionRules = extraction || {
      contentSelectors: ['article', 'main', '.content', '.post', 'body'],
      removeSelectors: ['script', 'style', 'iframe', 'nav', 'footer', '.ads', '.ad-container', 'noscript']
    }

    const extractResult = await page.evaluate((args) => {
      const { rules, metaRules } = args
      const result = { html: '', metadata: {} }

      if (rules.removeSelectors) {
        rules.removeSelectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
      }

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

      let targetEl = null
      for (const s of rules.contentSelectors) {
        const el = document.querySelector(s)
        if (el && el.innerText?.trim().length > 100) { targetEl = el; break }
      }
      if (!targetEl) targetEl = document.body

      targetEl.querySelectorAll('img').forEach(img => {
        const ds = img.getAttribute('data-src') || img.getAttribute('data-original')
        if (ds) img.setAttribute('src', ds)
      })

      result.html = targetEl.innerHTML
      return result
    }, { rules: extractionRules, metaRules: metadataRules })

    stats.extract = Date.now() - extractStart

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
}

module.exports = extractHandler
