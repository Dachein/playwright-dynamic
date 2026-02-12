/**
 * 🎧 音频切分接口（FFmpeg）
 */

const fs = require('fs').promises
const path = require('path')
const os = require('os')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

async function audioChunkHandler(req, res, { downloadWithRetry }) {
  const {
    audio_url,
    chunk_duration = 120,
    output_format = 'mp3'
  } = req.body

  if (!audio_url) {
    return res.status(400).json({ success: false, error: 'audio_url is required' })
  }

  console.log(`[ChunkAudio] 🎧 Starting: ${audio_url}, chunk: ${chunk_duration}s`)
  const startTime = Date.now()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-chunk-'))

  try {
    console.log(`[ChunkAudio] 📥 Downloading audio...`)
    const audioBuffer = await downloadWithRetry(audio_url, {
      timeout: 60000,
      maxRetries: 3,
      retryDelay: 2000
    })
    const inputPath = path.join(tempDir, `input.${output_format}`)
    await fs.writeFile(inputPath, audioBuffer)
    console.log(`[ChunkAudio] ✅ Downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`)

    const { stdout: durationOutput } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    )
    const totalDuration = parseFloat(durationOutput.trim())
    const chunkCount = Math.ceil(totalDuration / chunk_duration)

    console.log(`[ChunkAudio] 📊 Total duration: ${totalDuration.toFixed(1)}s, chunks: ${chunkCount}`)

    const chunks = []
    for (let i = 0; i < chunkCount; i++) {
      const chunkStart = i * chunk_duration
      const outputPath = path.join(tempDir, `chunk_${i + 1}.${output_format}`)

      const ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${chunkStart} -t ${chunk_duration} -c copy -avoid_negative_ts make_zero "${outputPath}" -y`

      try {
        await execAsync(ffmpegCmd)
        const chunkBuffer = await fs.readFile(outputPath)
        const chunkSize = chunkBuffer.length

        const base64 = chunkBuffer.toString('base64')

        chunks.push({
          index: i + 1,
          start_time: chunkStart,
          duration: Math.min(chunk_duration, totalDuration - chunkStart),
          size: chunkSize,
          data: base64,
          mime_type: `audio/${output_format === 'm4a' ? 'mp4' : output_format}`
        })

        console.log(`[ChunkAudio] ✅ Chunk ${i + 1}/${chunkCount}: ${(chunkSize / 1024 / 1024).toFixed(2)} MB`)
      } catch (error) {
        console.error(`[ChunkAudio] ⚠️ Failed to create chunk ${i + 1}:`, error.message)
      }
    }

    const duration = Date.now() - startTime
    console.log(`[ChunkAudio] 🎉 Done in ${duration}ms, ${chunks.length} chunks`)

    res.json({
      success: true,
      total_duration: totalDuration,
      chunk_duration,
      chunk_count: chunks.length,
      chunks,
      stats: {
        duration_ms: duration,
        total_size_mb: (audioBuffer.length / 1024 / 1024).toFixed(2)
      }
    })

  } catch (error) {
    console.error(`[ChunkAudio] ❌ Error:`, error)
    res.status(500).json({
      success: false,
      error: error.message,
      stats: { duration_ms: Date.now() - startTime }
    })
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (e) {
      console.warn(`[ChunkAudio] ⚠️ Failed to cleanup temp dir:`, e.message)
    }
  }
}

module.exports = audioChunkHandler
