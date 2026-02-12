/**
 * 📄 PDF 导出接口（支持净化）
 */

async function pdfHandler(req, res, { getBrowser, normalizeCookies }) {
  const {
    url,
    cookies,
    format = 'A4',
    printBackground = true,
    margin,
    displayHeaderFooter = false,
    headerTemplate,
    footerTemplate,
    scale = 1,
    landscape = false,
    extraction,
    browser: browserConfig
  } = req.body

  if (!url) return res.status(400).json({ success: false, error: 'URL is required' })

  console.log(`[PDF] 📄 Starting: ${url}`)
  const startTime = Date.now()
  let context = null

  try {
    const browser = await getBrowser()
    const normalizedCookies = normalizeCookies(cookies, url)

    context = await browser.newContext({
      userAgent: browserConfig?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      storageState: normalizedCookies.length > 0 ? { cookies: normalizedCookies } : undefined
    })

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 })
    } catch { }

    if (extraction) {
      if (extraction.removeSelectors?.length) {
        await page.evaluate((selectors) => {
          selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()))
        }, extraction.removeSelectors)
        console.log(`[PDF] 🧹 Removed elements: ${extraction.removeSelectors.join(', ')}`)
      }

      if (extraction.contentSelectors?.length) {
        const isolated = await page.evaluate((selectors) => {
          for (const s of selectors) {
            const el = document.querySelector(s)
            if (el && el.innerHTML.trim().length > 100) {
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

      await page.evaluate(() => {
        document.querySelectorAll('img').forEach(img => {
          const ds = img.getAttribute('data-src') || img.getAttribute('data-original')
          if (ds) img.setAttribute('src', ds)
        })
      })
    }

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
}

module.exports = pdfHandler
