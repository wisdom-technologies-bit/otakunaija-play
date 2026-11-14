#!/usr/bin/env node
/**
 * Live check for the ani-api, run by hand from a machine that can reach it.
 *
 *   ANI_API_BASE_URL=https://ani-api.kumoritv.top ANI_API_KEY=... \
 *     node scripts/ani-live-check.mjs
 *
 * It prints, for three known MAL ids, whether the stream was verified by the
 * provider embed, the variants it advertised and the subtitle labels it
 * returned. The key is read from the environment, sent as a header and never
 * printed, logged or included in an error message.
 */

const BASE = (process.env.ANI_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
const KEY = (process.env.ANI_API_KEY ?? '').trim()

const TARGETS = [
  { malId: 21, name: 'One Piece' },
  { malId: 52299, name: 'Solo Leveling' },
  { malId: 16498, name: 'Attack on Titan' },
]

if (!BASE || !KEY) {
  console.error('ani-live-check: set ANI_API_BASE_URL and ANI_API_KEY in the environment. Nothing was called.')
  process.exit(2)
}

async function check({ malId, name }) {
  const url = `${BASE}/v1/streams/mal/${malId}/episode/1?audio=sub&quality=best`
  const started = Date.now()
  let response
  try {
    response = await fetch(url, {
      headers: { 'X-API-Key': KEY, 'User-Agent': 'OtakuNaijaPlay', accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'NETWORK'
    console.log(`\nMAL ${malId} (${name}): request failed (${reason})`)
    return false
  }

  const ms = Date.now() - started
  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code = body && typeof body === 'object' ? (body.code ?? `HTTP_${response.status}`) : `HTTP_${response.status}`
    console.log(`\nMAL ${malId} (${name}): ${ms}ms -> ${code}`)
    return false
  }

  const mal = body?.mal ?? {}
  const variants = Array.isArray(body?.variants) ? body.variants : []
  const subtitles = Array.isArray(body?.subtitles) ? body.subtitles : []

  console.log(`\nMAL ${malId} (${name}): ${ms}ms`)
  console.log(`  stream_verified: ${mal.stream_verified === true}`)
  console.log(`  mal: ${mal.mal_id}/${mal.mal_episode} (${mal.verification ?? 'n/a'})`)
  console.log(`  stream_type: ${body?.stream_type ?? 'n/a'}`)
  console.log(`  variants: ${variants.length === 0 ? 'none' : variants.map((v) => `${v.quality}${v.playable ? '' : '*'}`).join(', ')}  (* = not playable)`)
  console.log(`  subtitles (${subtitles.length}):`)
  for (const track of subtitles) {
    console.log(
      `    - ${track.label ?? '(no label)'}  [lang=${track.language ?? 'n/a'} kind=${track.kind ?? 'n/a'} format=${track.format ?? 'n/a'} converted=${track.converted === true} playable=${track.playable === true} default=${track.default === true}]`,
    )
  }
  return mal.stream_verified === true
}

let verified = 0
for (const target of TARGETS) {
  if (await check(target)) verified += 1
}

console.log(`\n${verified}/${TARGETS.length} targets returned a provider-verified stream.`)
process.exit(verified === 0 ? 1 : 0)
