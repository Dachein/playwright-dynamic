/**
 * 🎭 Playwright Dynamic Service 配置
 */

const { version: VERSION } = require('../package.json')

// ============================================
// 服务器配置
// ============================================
const PORT = process.env.PORT || 3000
const API_TOKEN = process.env.API_TOKEN || 'mindtalk-secret-2026'

// ============================================
// Cloudflare Workers AI 配置（用于音频转录）
// ============================================
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID
const CF_WORKERS_AI_TOKEN = process.env.CF_WORKERS_AI_TOKEN
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo'
const MAX_WHISPER_SIZE = 25 * 1024 * 1024  // Workers AI Whisper 限制 25MB

// ============================================
// 智能分块策略配置
// ============================================
const TARGET_CHUNK_COUNT = 10        // 目标分块数
const MIN_CHUNK_DURATION = 120       // 最小 2 分钟
const MAX_CHUNK_DURATION = 900       // 最大 15 分钟
const THRESHOLD_DURATION = 6000      // 100 分钟阈值
const LONG_AUDIO_CHUNK = 600         // 长音频固定 10 分钟
const MAX_PARALLEL = 10              // 最大并行数
const MIN_DURATION_SECONDS = 300       // 最小时长 5 分钟

// ============================================
// 轮询配置
// ============================================
const POLL_INTERVAL_MS = 5000  // 轮询间隔 5 秒
const MAX_POLL_ATTEMPTS = 360  // 最多轮询 30 分钟 (360 * 5s)

module.exports = {
  VERSION,

  // 服务器
  PORT,
  API_TOKEN,

  // Cloudflare
  CF_ACCOUNT_ID,
  CF_WORKERS_AI_TOKEN,
  WHISPER_MODEL,
  MAX_WHISPER_SIZE,

  // 智能分块
  TARGET_CHUNK_COUNT,
  MIN_CHUNK_DURATION,
  MAX_CHUNK_DURATION,
  THRESHOLD_DURATION,
  LONG_AUDIO_CHUNK,
  MAX_PARALLEL,
  MIN_DURATION_SECONDS,

  // 轮询
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS
}
