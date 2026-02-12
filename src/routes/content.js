/**
 * 📄 Content 路由（向后兼容）
 */

async function contentHandler(req, res, { getBrowser }) {
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
}

module.exports = contentHandler
