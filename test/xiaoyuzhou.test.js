const { test } = require('node:test')
const assert = require('node:assert/strict')
const { xiaoyuzhouHandler, parseEpisodeHtml } = require('../src/routes/xiaoyuzhou')

const id = '6acef4af8c09f0c493c1c39b'
const episode = { eid: id, title: 'Test episode', duration: 2655, enclosure: { url: 'https://media.xyzcdn.net/audio.mp3' } }
const html = (ep = episode) => `<script nonce="test" type="application/json" id='__NEXT_DATA__'>${JSON.stringify({ props: { pageProps: { episode: ep } } })}</script>`
const reply = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this }, json(value) { this.body = value; return this } })

test('reads Next data regardless of attribute order or quote style', () => {
  assert.deepEqual(parseEpisodeHtml(html(), id), episode)
})

test('uses ordinary HTTP for a fixed public episode URL', async () => {
  const res = reply()
  await xiaoyuzhouHandler({ body: { episode_id: id } }, res, { fetchImpl: async (url, options) => {
    assert.equal(url, `https://www.xiaoyuzhoufm.com/episode/${id}`)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    return new Response(html())
  } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.stats.transport, 'http')
  assert.deepEqual(res.body.episode, episode)
})

test('rejects arbitrary URLs and path injection without fetching', async () => {
  for (const episode_id of ['https://127.0.0.1', '../admin', id + '?url=bad', null]) {
    const res = reply()
    await xiaoyuzhouHandler({ body: { episode_id } }, res, { fetchImpl: () => assert.fail('must not fetch') })
    assert.equal(res.statusCode, 400)
  }
})

test('reports upstream HTTP status without returning a gateway page', async () => {
  const res = reply()
  await xiaoyuzhouHandler({ body: { episode_id: id } }, res, { fetchImpl: async () => new Response('private gateway page', { status: 403 }) })
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.upstream_status, 403)
  assert.equal(res.body.error, 'episode_page_http_error')
  assert.ok(!JSON.stringify(res.body).includes('private gateway'))
})

test('rejects missing, mismatched, or incomplete episode data', () => {
  assert.throws(() => parseEpisodeHtml('<html>challenge</html>', id), /episode_data_missing/)
  assert.throws(() => parseEpisodeHtml('<script id="__NEXT_DATA__">bad</script>', id), /invalid_json/)
  for (const change of [{ eid: 'another' }, { duration: 0 }, { duration: '2655' }, { title: '' }]) {
    assert.throws(() => parseEpisodeHtml(html({ ...episode, ...change }), id), /episode_data_invalid/)
  }
  assert.throws(() => parseEpisodeHtml(html({ ...episode, enclosure: {} }), id), /episode_audio_missing/)
  assert.throws(() => parseEpisodeHtml(html({ ...episode, enclosure: { url: 'file:///tmp/audio' } }), id), /episode_audio_invalid/)
})

test('bounds page size even without content-length', async () => {
  const res = reply()
  await xiaoyuzhouHandler({ body: { episode_id: id } }, res, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) })
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error, 'episode_page_too_large')
})

test('network failures have a stable error without leaking their URL', async () => {
  const res = reply()
  await xiaoyuzhouHandler({ body: { episode_id: id } }, res, { fetchImpl: async () => { throw new Error('https://private?token=secret') } })
  assert.equal(res.statusCode, 502)
  assert.equal(res.body.error, 'episode_page_fetch_failed')
})
