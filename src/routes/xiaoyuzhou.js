/** Fetch public episode data on the selected node without starting a browser. */
const MAX_HTML_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15000

function episodeError(code, upstreamStatus) {
  const error = new Error(code)
  error.code = code
  error.upstreamStatus = upstreamStatus
  return error
}

function parseEpisodeHtml(html, episodeId) {
  const script = html.match(/<script\b[^>]*\bid\s*=\s*(["'])__NEXT_DATA__\1[^>]*>([\s\S]*?)<\/script\s*>/i)
  if (!script) throw episodeError('episode_data_missing')
  let data
  try { data = JSON.parse(script[2]) } catch { throw episodeError('episode_data_invalid_json') }
  const episode = data?.props?.pageProps?.episode
  if (episode?.eid !== episodeId || typeof episode?.title !== 'string' || !episode.title.trim()
      || !Number.isFinite(episode?.duration) || episode.duration <= 0) {
    throw episodeError('episode_data_invalid')
  }
  let audioUrl
  try { audioUrl = new URL(episode.enclosure?.url) } catch { throw episodeError('episode_audio_missing') }
  if (!['http:', 'https:'].includes(audioUrl.protocol)) throw episodeError('episode_audio_invalid')
  return episode
}

async function readHtml(response) {
  if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) {
    await response.body?.cancel()
    throw episodeError('episode_page_too_large')
  }
  if (!response.body) throw episodeError('episode_page_empty')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_HTML_BYTES) {
        await reader.cancel()
        throw episodeError('episode_page_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function xiaoyuzhouHandler(req, res, { fetchImpl = fetch } = {}) {
  const episodeId = req.body?.episode_id
  if (typeof episodeId !== 'string' || !/^[a-f0-9]{24}$/i.test(episodeId)) {
    return res.status(400).json({ success: false, error: 'invalid_episode_id' })
  }
  // Accept an ID, never a caller-supplied URL; this is not a general HTTP proxy.
  const pageUrl = `https://www.xiaoyuzhoufm.com/episode/${episodeId}`
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(pageUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' }
    })
    console.log(`[Xiaoyuzhou] episode=${episodeId} upstream_status=${response.status}`)
    if (!response.ok) {
      await response.body?.cancel()
      throw episodeError('episode_page_http_error', response.status)
    }
    const episode = parseEpisodeHtml(await readHtml(response), episodeId)
    return res.json({ success: true, episode, stats: { transport: 'http', duration_ms: Date.now() - started } })
  } catch (error) {
    const code = controller.signal.aborted ? 'episode_page_timeout' : (error.code || 'episode_page_fetch_failed')
    console.warn(`[Xiaoyuzhou] episode=${episodeId} error=${code} upstream_status=${error.upstreamStatus || 'none'}`)
    return res.status(controller.signal.aborted ? 504 : 502).json({
      success: false, error: code, upstream_status: error.upstreamStatus
    })
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { xiaoyuzhouHandler, parseEpisodeHtml }
