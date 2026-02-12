/**
 * 🌐 全局浏览器实例管理
 */

const { chromium } = require('playwright')

let browserPromise = null

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    })
  }
  return browserPromise
}

module.exports = { getBrowser }
