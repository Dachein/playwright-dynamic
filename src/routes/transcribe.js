/**
 * 🎙️ 音频转录接口
 */

const config = require('../config')
const {
  transcriptionTasks,
  executeTranscriptionTask
} = require('../services/transcription')

function transcribeHandler(req, res, deps) {
  const {
    getDownloadMethod,
    downloadWithPlaywright,
    downloadWithRetry
  } = deps

  const {
    audio_url,
    language = 'auto',
    chunk_duration,
    max_parallel,
    expected_duration
  } = req.body

  const {
    CF_ACCOUNT_ID,
    CF_WORKERS_AI_TOKEN,
    MIN_DURATION_SECONDS,
    MAX_CHUNK_DURATION,
    MAX_PARALLEL
  } = config

  if (!audio_url) {
    return res.status(400).json({ success: false, error: 'audio_url is required' })
  }

  if (!CF_ACCOUNT_ID || !CF_WORKERS_AI_TOKEN) {
    return res.status(500).json({
      success: false,
      error: 'CF_ACCOUNT_ID and CF_WORKERS_AI_TOKEN must be configured'
    })
  }

  if (expected_duration && expected_duration < MIN_DURATION_SECONDS) {
    return res.status(400).json({
      success: false,
      error: `音频时长不足 5 分钟 (${Math.floor(expected_duration / 60)}分钟)，不支持转录`,
      code: 'DURATION_TOO_SHORT'
    })
  }

  const safeChunkDuration = chunk_duration
    ? Math.min(chunk_duration, MAX_CHUNK_DURATION)
    : null
  const safeMaxParallel = Math.min(max_parallel || MAX_PARALLEL, MAX_PARALLEL)

  const taskId = `trans_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()

  transcriptionTasks.set(taskId, {
    status: 'pending',
    progress: 0,
    message: 'CODE:PENDING',
    audio_url,
    language,
    chunk_duration: safeChunkDuration,
    max_parallel: safeMaxParallel,
    created_at: now,
    updated_at: now
  })

  console.log(`[Transcribe] 🎙️ Task created: ${taskId}`)

  res.json({
    success: true,
    task_id: taskId,
    message: 'Task created'
  })

  executeTranscriptionTask(taskId, {
    getDownloadMethod,
    downloadWithPlaywright,
    downloadWithRetry,
    config: config
  }).catch(error => {
    console.error(`[Transcribe] ❌ Task ${taskId} failed:`, error.message)
  })
}

function transcribeStatusHandler(req, res) {
  const { task_id } = req.params

  const task = transcriptionTasks.get(task_id)
  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'Task not found or expired'
    })
  }

  const response = {
    success: true,
    task_id,
    status: task.status,
    progress: task.progress,
    message: task.message,
    created_at: task.created_at,
    updated_at: task.updated_at
  }

  if (task.status === 'completed') {
    response.transcript = task.transcript
    response.word_count = task.word_count
    response.stats = task.stats
  }

  if (task.status === 'failed') {
    response.error = task.error
  }

  res.json(response)
}

module.exports = {
  transcribeHandler,
  transcribeStatusHandler
}
