/**
 * 🎙️ 音频转录服务
 */

const fs = require('fs').promises
const path = require('path')
const os = require('os')
const { exec } = require('child_process')
const { promisify } = require('util')

const execAsync = promisify(exec)

const transcriptionTasks = new Map()

// 清理过期任务（超过 1 小时）
setInterval(() => {
  const now = Date.now()
  const ONE_HOUR = 60 * 60 * 1000
  for (const [taskId, task] of transcriptionTasks) {
    if (now - task.created_at > ONE_HOUR) {
      transcriptionTasks.delete(taskId)
      console.log(`[TaskCleanup] Removed expired task: ${taskId}`)
    }
  }
}, 10 * 60 * 1000)

function calculateOptimalChunkDuration(totalDuration, config) {
  const { THRESHOLD_DURATION, LONG_AUDIO_CHUNK, TARGET_CHUNK_COUNT, MIN_CHUNK_DURATION, MAX_CHUNK_DURATION } = config

  if (totalDuration >= THRESHOLD_DURATION) {
    return LONG_AUDIO_CHUNK
  }

  let chunkDuration = Math.ceil(totalDuration / TARGET_CHUNK_COUNT)
  chunkDuration = Math.max(MIN_CHUNK_DURATION, chunkDuration)
  chunkDuration = Math.min(MAX_CHUNK_DURATION, chunkDuration)

  return chunkDuration
}

async function callWhisperAPI(base64Audio, language, config) {
  const { CF_ACCOUNT_ID, CF_WORKERS_AI_TOKEN, WHISPER_MODEL } = config
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${WHISPER_MODEL}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_WORKERS_AI_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio: base64Audio,
      task: 'transcribe',
      language: language === 'auto' ? undefined : language,
      vad_filter: true
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Whisper API error: ${response.status} - ${errorText.slice(0, 200)}`)
  }

  const result = await response.json()

  if (result.result && typeof result.result.text === 'string') {
    return result.result.text
  }
  if (result.text) {
    return result.text
  }
  if (typeof result === 'string') {
    return result
  }

  throw new Error(`Unexpected Whisper API response format: ${JSON.stringify(result).slice(0, 200)}`)
}

async function executeTranscriptionTask(taskId, deps) {
  const {
    getDownloadMethod,
    downloadWithPlaywright,
    downloadWithRetry,
    config
  } = deps

  const task = transcriptionTasks.get(taskId)
  if (!task) return

  const {
    MIN_DURATION_SECONDS,
    MAX_WHISPER_SIZE,
    TARGET_CHUNK_COUNT,
    MIN_CHUNK_DURATION,
    MAX_CHUNK_DURATION,
    THRESHOLD_DURATION,
    LONG_AUDIO_CHUNK
  } = config

  const updateTask = (updates) => {
    Object.assign(task, updates, { updated_at: Date.now() })
    transcriptionTasks.set(taskId, task)
  }

  const startTime = Date.now()
  const stats = { download: 0, probe: 0, split: 0, transcribe: 0, total: 0 }
  let tempDir = null

  try {
    updateTask({ status: 'downloading', progress: 5, message: 'CODE:LOADING' })
    console.log(`[Task ${taskId}] 📥 Downloading: ${task.audio_url}`)

    const downloadStart = Date.now()
    let audioBuffer = null

    const downloadMethod = getDownloadMethod(task.audio_url)
    console.log(`[Task ${taskId}] 📋 Download method: ${downloadMethod}`)

    if (downloadMethod === 'playwright') {
      audioBuffer = await downloadWithPlaywright(task.audio_url, { timeout: 180000 })
    } else {
      audioBuffer = await downloadWithRetry(task.audio_url, {
        timeout: 180000,
        maxRetries: 3,
        retryDelay: 3000
      })
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-async-'))
    const inputPath = path.join(tempDir, 'input.audio')
    await fs.writeFile(inputPath, audioBuffer)

    stats.download = Date.now() - downloadStart
    const fileSizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2)
    updateTask({ progress: 20, message: 'CODE:LOADING' })
    console.log(`[Task ${taskId}] ✅ Downloaded: ${fileSizeMB} MB`)

    const probeStart = Date.now()
    const { stdout: durationOutput } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    )
    const totalDuration = parseFloat(durationOutput.trim())
    stats.probe = Date.now() - probeStart
    console.log(`[Task ${taskId}] 📊 Duration: ${totalDuration.toFixed(1)}s`)

    if (totalDuration < MIN_DURATION_SECONDS) {
      throw new Error(`音频时长不足 5 分钟 (${Math.floor(totalDuration / 60)}分${Math.floor(totalDuration % 60)}秒)，不支持转录`)
    }

    const chunkDuration = task.chunk_duration || calculateOptimalChunkDuration(totalDuration, config)
    const chunkCount = Math.ceil(totalDuration / chunkDuration)

    console.log(`[Task ${taskId}] 📐 Chunk strategy: ${Math.floor(chunkDuration / 60)}min × ${chunkCount} chunks (total: ${Math.floor(totalDuration / 60)}min)`)

    updateTask({ status: 'splitting', progress: 20, message: `CODE:SPLITTING|0|${chunkCount}` })
    const pipelineStart = Date.now()

    const maxParallel = task.max_parallel || 10
    const transcripts = []
    const activeTranscriptions = []
    let splitCount = 0
    let transcribeCount = 0
    let successCount = 0

    console.log(`[Task ${taskId}] 🎯 Pipeline mode: split & transcribe (parallel: ${maxParallel})`)

    const transcribeChunk = async (chunk) => {
      try {
        const text = await callWhisperAPI(chunk.data, task.language, config)
        return { index: chunk.index, text, success: true }
      } catch (error) {
        console.error(`[Task ${taskId}] ❌ Chunk ${chunk.index + 1} transcribe failed:`, error.message)
        return { index: chunk.index, text: '', success: false }
      }
    }

    const onTranscribeComplete = (result) => {
      transcripts.push(result)
      transcribeCount++
      if (result.success) successCount++

      if (splitCount >= chunkCount) {
        const transcribeProgress = 50 + Math.floor((transcribeCount / chunkCount) * 40)
        updateTask({
          status: 'transcribing',
          progress: transcribeProgress,
          message: `CODE:TRANSCRIBING|${transcribeCount}|${chunkCount}|${successCount}`
        })
      }
    }

    for (let i = 0; i < chunkCount; i++) {
      const chunkStart = i * chunkDuration
      const outputPath = path.join(tempDir, `chunk_${i}.mp3`)
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -ss ${chunkStart} -t ${chunkDuration} -vn -acodec libmp3lame -q:a 4 "${outputPath}" -y 2>/dev/null`

      try {
        await execAsync(ffmpegCmd)
        const chunkBuffer = await fs.readFile(outputPath)

        if (chunkBuffer.length <= MAX_WHISPER_SIZE) {
          const chunk = {
            index: i,
            start_time: chunkStart,
            duration: Math.min(chunkDuration, totalDuration - chunkStart),
            data: chunkBuffer.toString('base64'),
            size: chunkBuffer.length
          }

          if (activeTranscriptions.length >= maxParallel) {
            const { result, index: doneIdx } = await Promise.race(
              activeTranscriptions.map((p, idx) => p.then(r => ({ result: r, index: idx })))
            )
            onTranscribeComplete(result)
            activeTranscriptions.splice(doneIdx, 1)
          }

          const transcriptionPromise = transcribeChunk(chunk)
          activeTranscriptions.push(transcriptionPromise)

          chunk.data = null
        }
      } catch (error) {
        console.warn(`[Task ${taskId}] ⚠️ Chunk ${i + 1} split failed:`, error.message)
      }

      splitCount++

      const splitProgress = 20 + Math.floor((splitCount / chunkCount) * 30)
      updateTask({ progress: splitProgress, message: `CODE:SPLITTING|${splitCount}|${chunkCount}` })
    }

    console.log(`[Task ${taskId}] ✅ Split complete: ${splitCount} chunks, waiting for ${activeTranscriptions.length} transcriptions...`)

    updateTask({
      status: 'transcribing',
      progress: 50 + Math.floor((transcribeCount / chunkCount) * 40),
      message: `CODE:TRANSCRIBING|${transcribeCount}|${chunkCount}|${successCount}`
    })

    const remainingResults = await Promise.all(activeTranscriptions)
    remainingResults.forEach(onTranscribeComplete)

    stats.split = Date.now() - pipelineStart
    stats.transcribe = stats.split

    console.log(`[Task ${taskId}] ✅ Pipeline complete: ${successCount}/${chunkCount} successful`)

    transcripts.sort((a, b) => a.index - b.index)
    const fullTranscript = transcripts
      .filter(t => t.text)
      .map(t => t.text.trim())
      .join('\n\n')

    const wordCount = fullTranscript.length
    successCount = transcripts.filter(t => t.success).length
    stats.total = Date.now() - startTime

    console.log(`[Task ${taskId}] 🎉 Complete: ${wordCount} chars, ${successCount}/${chunkCount} chunks, ${stats.total}ms`)

    updateTask({
      status: 'completed',
      progress: 100,
      message: 'CODE:COMPLETED',
      transcript: fullTranscript,
      word_count: wordCount,
      stats: {
        duration_seconds: totalDuration,
        file_size_mb: parseFloat(fileSizeMB),
        chunk_duration_seconds: chunkDuration,
        chunk_count: chunkCount,
        successful_chunks: successCount,
        timing: stats
      }
    })

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Task ${taskId}] ❌ Failed:`, errorMsg)

    updateTask({
      status: 'failed',
      progress: 0,
      message: 'CODE:FAILED',
      error: errorMsg
    })
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.warn(`[Task ${taskId}] ⚠️ Cleanup failed:`, e.message)
      }
    }
  }
}

module.exports = {
  transcriptionTasks,
  executeTranscriptionTask
}
