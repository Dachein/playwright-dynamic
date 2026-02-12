/**
 * 📊 健康检查路由
 */

const { exec } = require('child_process')
const { promisify } = require('util')
const execAsync = promisify(exec)

async function healthHandler(req, res, { VERSION, MIN_DURATION_SECONDS, TARGET_CHUNK_COUNT, MAX_CHUNK_DURATION, MAX_PARALLEL }) {
  let ffmpegVersion = null
  try {
    const { stdout } = await execAsync('ffmpeg -version | head -n 1')
    ffmpegVersion = stdout.trim()
  } catch (e) {
    console.warn('[Health] ⚠️ FFmpeg not available')
  }

  let gitCommit = null
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD')
    gitCommit = stdout.trim()
  } catch (e) { }

  res.json({
    status: 'ok',
    service: 'playwright-cn',
    version: VERSION,
    commit: gitCommit,
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
}

module.exports = healthHandler
