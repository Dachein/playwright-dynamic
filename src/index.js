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
const cors = require('cors')

// ============================================
// 配置和常量
// ============================================
const config = require('./config')
const {
  VERSION,
  PORT,
  API_TOKEN,
  CF_ACCOUNT_ID,
  CF_WORKERS_AI_TOKEN,
  TARGET_CHUNK_COUNT,
  MIN_CHUNK_DURATION,
  MAX_CHUNK_DURATION,
  THRESHOLD_DURATION,
  LONG_AUDIO_CHUNK,
  MAX_PARALLEL,
  MIN_DURATION_SECONDS
} = config

// ============================================
// 中间件
// ============================================
const { authMiddleware } = require('./middleware/auth')

// ============================================
// 工具函数
// ============================================
const { getBrowser } = require('./utils/browser')
const { normalizeCookies } = require('./utils/cookies')
const { getDownloadMethod, downloadWithPlaywright, downloadWithRetry } = require('./utils/download')

// ============================================
// 路由
// ============================================
const healthRoute = require('./routes/health')
const contentRoute = require('./routes/content')
const extractRoute = require('./routes/extract')
const screenshotRoute = require('./routes/screenshot')
const pdfRoute = require('./routes/pdf')
const audioChunkRoute = require('./routes/audio-chunk')
const { transcribeHandler, transcribeStatusHandler } = require('./routes/transcribe')

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ============================================
// 注册路由
// ============================================
app.get('/health', (req, res) => healthRoute(req, res, {
  VERSION, MIN_DURATION_SECONDS, TARGET_CHUNK_COUNT, MAX_CHUNK_DURATION, MAX_PARALLEL
}))

app.post('/extract', authMiddleware, (req, res) => extractRoute(req, res, { getBrowser, normalizeCookies }))

app.post('/content', authMiddleware, (req, res) => contentRoute(req, res, { getBrowser }))

app.post('/screenshot', authMiddleware, (req, res) => screenshotRoute(req, res, { getBrowser, normalizeCookies }))

app.post('/pdf', authMiddleware, (req, res) => pdfRoute(req, res, { getBrowser, normalizeCookies }))

app.post('/chunk-audio', authMiddleware, (req, res) => audioChunkRoute(req, res, { downloadWithRetry }))

app.post('/transcribe', authMiddleware, (req, res) => transcribeHandler(req, res, {
  getDownloadMethod,
  downloadWithPlaywright,
  downloadWithRetry
}))

app.get('/transcribe-status/:task_id', authMiddleware, transcribeStatusHandler)

// ============================================
// 🚀 启动
// ============================================
app.listen(PORT, () => {
  console.log(`
🎭 Playwright Dynamic Service v${VERSION}
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
