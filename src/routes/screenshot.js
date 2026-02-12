/**
 * 📸 截图接口
 */

async function screenshotHandler(req, res, { getBrowser, normalizeCookies }) {
  const {
    url,
    cookies,
    fullPage = false,
    type = 'png',
    quality = 80,
    selector,
    viewport,
    clip,
    extraction,
    browser: browserConfig
  } = req.body

  if (!url) return res.status(400).json({ success: false, error: 'URL is required' })

  console.log(`[Screenshot] 📸 Starting: ${url}`)
  const startTime = Date.now()
  let context = null

  try {
    const browser = await getBrowser()
    const normalizedCookies = normalizeCookies(cookies, url)

    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      viewport: viewport || { width: 375, height: 812 },
      isMobile: !viewport,
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 })
    } catch { }

    if (browserConfig?.waitForSelector) {
      try {
        await page.waitForSelector(browserConfig.waitForSelector, {
          state: 'attached',
          timeout: browserConfig?.waitTimeout || 15000
        })
        console.log(`[Screenshot] ✅ Selector "${browserConfig.waitForSelector}" found`)
      } catch (e) {
        console.log(`[Screenshot] ⚠️ Selector "${browserConfig.waitForSelector}" timeout`)
      }
    }

    if (extraction?.removeSelectors) {
      await page.evaluate((selectors) => {
        selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
      }, extraction.removeSelectors)
      console.log(`[Screenshot] 🧹 Cleaned ${extraction.removeSelectors.length} selector types`)
    }

    const screenshotOptions = {
      type,
      fullPage,
      ...(type === 'jpeg' ? { quality } : {})
    }

    let screenshot
    if (selector && clip) {
      const element = await page.$(selector)
      if (!element) {
        return res.status(400).json({ success: false, error: `Selector "${selector}" not found` })
      }
      const box = await element.boundingBox()
      if (!box) {
        return res.status(400).json({ success: false, error: `Cannot get bounding box for "${selector}"` })
      }
      const absoluteClip = {
        x: box.x + (clip.x || 0),
        y: box.y + (clip.y || 0),
        width: clip.width || box.width,
        height: clip.height || box.height
      }
      console.log(`[Screenshot] 📐 Clip: element at (${box.x}, ${box.y}), clip to (${absoluteClip.x}, ${absoluteClip.y}, ${absoluteClip.width}x${absoluteClip.height})`)
      screenshot = await page.screenshot({ ...screenshotOptions, clip: absoluteClip })
    } else if (selector) {
      const element = await page.$(selector)
      if (!element) {
        return res.status(400).json({ success: false, error: `Selector "${selector}" not found` })
      }
      screenshot = await element.screenshot(screenshotOptions)
    } else if (clip) {
      screenshot = await page.screenshot({ ...screenshotOptions, clip })
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
}

module.exports = screenshotHandler
