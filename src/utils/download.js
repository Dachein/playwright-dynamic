const fs = require('fs')
const { getBrowser } = require('./browser')

/**
 * 🎯 根据音频 URL 判断下载方式
 * @param {string} url - 音频文件 URL
 * @returns {'playwright' | 'fetch'} 下载方法
 */
function getDownloadMethod(url) {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname.toLowerCase()

    // Substack 相关域名必须用 Playwright（防盗链）
    if (hostname.includes('substack.com') ||
        hostname.includes('api.substack.com') ||
        hostname.includes('substackcdn.com')) {
      console.log(`[DownloadMethod] 📋 Substack detected → playwright`)
      return 'playwright'
    }

    // 其他源使用 fetch（更快）
    console.log(`[DownloadMethod] 📋 Generic source → fetch`)
    return 'fetch'

  } catch (e) {
    console.warn(`[DownloadMethod] ⚠️ Invalid URL, default to fetch:`, url)
    return 'fetch'
  }
}

/**
 * 🎭 使用 Playwright 浏览器下载（更好的反爬虫处理）
 */
async function downloadWithPlaywright(url, options = {}) {
  const { timeout = 180000 } = options

  console.log(`[Download] 🎭 Using Playwright browser: ${url}`)

  const browser = await getBrowser()

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  })

  try {
    const page = await context.newPage()

    // 🎭 反检测注入
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    console.log(`[Download] 🎭 Setting up download handler...`)

    // 等待下载事件
    const downloadPromise = page.waitForEvent('download', { timeout })

    console.log(`[Download] 🎭 Navigating to URL...`)

    // 访问 URL（会触发下载），忽略导航错误
    page.goto(url, {
      waitUntil: 'commit',
      timeout
    }).catch(e => {
      console.log(`[Download] ⚠️ Navigation interrupted (expected for download): ${e.message}`)
    })

    // 等待下载开始
    const download = await downloadPromise
    console.log(`[Download] ✅ Download started`)

    // 获取下载路径
    const filePath = await download.path()
    console.log(`[Download] 📥 Downloaded to: ${filePath}`)

    // 读取文件
    const buffer = fs.readFileSync(filePath)
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(2)
    console.log(`[Download] ✅ Downloaded: ${sizeMB} MB`)

    await context.close()
    return buffer

  } catch (error) {
    await context.close()
    console.error(`[Download] ❌ Playwright error:`, error.message)
    throw error
  }
}

/**
 * 📥 普通下载函数（超时 + 重试，支持重定向 + Cookie）
 */
async function downloadWithRetry(url, options = {}) {
  const {
    timeout = 60000,
    maxRetries = 3,
    retryDelay = 2000
  } = options

  let lastError = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Download] Attempt ${attempt}/${maxRetries}: ${url}`)

      // 使用 AbortController 实现超时
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      // 从 URL 提取 origin 用于 Referer（防盗链）
      let referer = 'https://substack.com'
      try {
        const urlObj = new URL(url)
        referer = `${urlObj.protocol}//${urlObj.hostname}/`
      } catch (e) {
        console.warn(`[Download] ⚠️ Cannot parse URL for Referer`)
      }

      // 🎯 关键修复：手动处理重定向，确保请求头正确传递
      let finalUrl = url
      let redirectCount = 0
      const maxRedirects = 5
      let response = null

      while (redirectCount <= maxRedirects) {
        response = await fetch(finalUrl, {
          signal: controller.signal,
          redirect: 'manual',  // 手动处理重定向
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': referer,
            'Origin': referer,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site',
            'Connection': 'keep-alive'
          }
        })

        // 检查重定向
        if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
          const location = response.headers.get('location')
          if (location) {
            console.log(`[Download] 🔄 Redirect ${redirectCount + 1}: ${response.status} → ${location}`)
            finalUrl = location
            redirectCount++
            continue
          }
        }

        // 非 3xx 响应，结束循环
        break
      }

      clearTimeout(timeoutId)

      if (!response || !response.ok) {
        const status = response?.status || 'unknown'
        const statusText = response?.statusText || 'unknown'
        console.log(`[Download] ❌ HTTP ${status} ${statusText}`)
        if (response?.headers) {
          console.log(`[Download] Response headers:`, Object.fromEntries(response.headers.entries()))
        }
        throw new Error(`HTTP ${status}: ${statusText}`)
      }

      // 记录响应信息（调试用）
      const contentType = response.headers.get('content-type')
      const contentLength = response.headers.get('content-length')
      console.log(`[Download] ✅ Response OK: ${contentType}, ${contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(2) + ' MB' : 'unknown size'}`)

      // 流式下载，避免一次性加载大文件到内存
      const chunks = []
      const reader = response.body.getReader()
      let receivedLength = 0
      let lastLogTime = Date.now()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        receivedLength += value.length

        // 每 5 秒打印一次进度
        const now = Date.now()
        if (now - lastLogTime > 5000) {
          console.log(`[Download] 📥 Progress: ${(receivedLength / 1024 / 1024).toFixed(2)} MB`)
          lastLogTime = now
        }
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
      const isTimeout = error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('aborted')
      const isNetworkError = error.message.includes('ECONNRESET') || error.message.includes('ETIMEDOUT') || error.message.includes('fetch failed')

      console.log(`[Download] ❌ Attempt ${attempt} failed: ${error.message}`)

      if (attempt < maxRetries && (isTimeout || isNetworkError)) {
        console.log(`[Download] ⚠️ Retrying in ${retryDelay}ms...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      } else {
        throw error
      }
    }
  }

  throw lastError || new Error('Download failed after all retries')
}

module.exports = {
  getDownloadMethod,
  downloadWithPlaywright,
  downloadWithRetry
}
