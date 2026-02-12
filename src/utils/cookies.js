/**
 * 🍪 Cookie 规范化（统一处理 domain/path pair）
 */

function normalizeCookies(cookies, targetUrl) {
  if (!cookies || cookies.length === 0) return []

  let defaultDomain = ''
  try {
    const urlObj = new URL(targetUrl)
    defaultDomain = urlObj.hostname
  } catch (e) {
    console.warn(`[Cookie] ⚠️ Cannot parse URL: ${targetUrl}`)
  }

  const normalized = cookies
    .filter(c => c.name && c.value)
    .map(c => {
      let domain = c.domain
      if (!domain || domain.trim() === '') {
        domain = defaultDomain
      }
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
    .filter(c => c.domain)

  if (normalized.length > 0 && normalized.length !== cookies.length) {
    console.log(`[Cookie] 🍪 Normalized ${normalized.length}/${cookies.length} cookies → domain: ${normalized[0].domain}`)
  } else if (normalized.length > 0) {
    console.log(`[Cookie] 🍪 ${normalized.length} cookies ready for domain: ${normalized[0].domain}`)
  }

  return normalized
}

module.exports = { normalizeCookies }
