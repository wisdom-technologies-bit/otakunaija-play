import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STREAM_CACHE_TTL_SECONDS,
  MAX_STREAM_CACHE_TTL_SECONDS,
  readCachedStream,
  streamCacheTtlSeconds,
  writeCachedStream,
  type StreamCacheClient,
} from '../lib/stream-cache'

type StubOptions = {
  row?: unknown
  readError?: unknown
  writeError?: unknown
  throwOnRead?: boolean
  throwOnWrite?: boolean
}

function stubClient(options: StubOptions = {}) {
  const writes: Array<{ table: string; values: unknown; onConflict?: string }> = []
  const reads: Array<{ table: string; columns?: string; pairs: Array<[string, unknown]> }> = []

  const client: StreamCacheClient = {
    from(table: string) {
      return {
        select(columns?: string) {
          const pairs: Array<[string, unknown]> = []
          reads.push({ table, columns, pairs })
          const chain = {
            eq(column: string, value: unknown) {
              pairs.push([column, value])
              return chain
            },
            async maybeSingle() {
              if (options.throwOnRead) throw new Error('network down')
              return { data: options.row ?? null, error: options.readError ?? null }
            },
          }
          return chain
        },
        async upsert(values: unknown, upsertOptions?: { onConflict?: string }) {
          if (options.throwOnWrite) throw new Error('network down')
          writes.push({ table, values, onConflict: upsertOptions?.onConflict })
          return { error: options.writeError ?? null }
        },
      } as never
    },
  }

  return { client, writes, reads }
}

describe('stream cache TTL', () => {
  it('defaults inside the window a proxy signature can honour', () => {
    expect(streamCacheTtlSeconds({})).toBe(DEFAULT_STREAM_CACHE_TTL_SECONDS)
    expect(DEFAULT_STREAM_CACHE_TTL_SECONDS).toBeLessThanOrEqual(MAX_STREAM_CACHE_TTL_SECONDS)
  })

  it('reads ANI_STREAM_CACHE_TTL_SECONDS and clamps it', () => {
    expect(streamCacheTtlSeconds({ ANI_STREAM_CACHE_TTL_SECONDS: '120' })).toBe(120)
    expect(streamCacheTtlSeconds({ ANI_STREAM_CACHE_TTL_SECONDS: '1' })).toBe(30)
    expect(streamCacheTtlSeconds({ ANI_STREAM_CACHE_TTL_SECONDS: '999999' })).toBe(MAX_STREAM_CACHE_TTL_SECONDS)
    expect(streamCacheTtlSeconds({ ANI_STREAM_CACHE_TTL_SECONDS: 'nonsense' })).toBe(DEFAULT_STREAM_CACHE_TTL_SECONDS)
  })
})

describe('readCachedStream', () => {
  const now = Date.parse('2026-11-17T21:00:00.000Z')
  const fresh = new Date(now + 60_000).toISOString()
  const stale = new Date(now - 1_000).toISOString()

  it('returns the payload of a live row, keyed on play id and audio', async () => {
    const { client, reads } = stubClient({ row: { payload: { streamUrl: '/api/proxy/manifest?u=x' }, expires_at: fresh } })
    const payload = await readCachedStream(client, { playId: '179876-6', audio: 'sub' }, now)

    expect(payload).toEqual({ streamUrl: '/api/proxy/manifest?u=x' })
    expect(reads[0].table).toBe('stream_cache')
    expect(reads[0].pairs).toEqual([
      ['play_id', '179876-6'],
      ['audio', 'sub'],
    ])
  })

  it('treats an expired row as a miss', async () => {
    const { client } = stubClient({ row: { payload: { streamUrl: 'x' }, expires_at: stale } })
    expect(await readCachedStream(client, { playId: 'a', audio: 'sub' }, now)).toBeNull()
  })

  it('treats a row without a readable expiry as a miss', async () => {
    const { client } = stubClient({ row: { payload: { streamUrl: 'x' }, expires_at: null } })
    expect(await readCachedStream(client, { playId: 'a', audio: 'sub' }, now)).toBeNull()
  })

  it('ignores a malformed payload', async () => {
    const { client } = stubClient({ row: { payload: 'not-an-object', expires_at: fresh } })
    expect(await readCachedStream(client, { playId: 'a', audio: 'sub' }, now)).toBeNull()
  })

  it('is a miss, not an error, when the table does not exist', async () => {
    const { client } = stubClient({ readError: { code: '42P01', message: 'relation "stream_cache" does not exist' } })
    expect(await readCachedStream(client, { playId: 'a', audio: 'sub' }, now)).toBeNull()
  })

  it('survives a thrown transport error', async () => {
    const { client } = stubClient({ throwOnRead: true })
    expect(await readCachedStream(client, { playId: 'a', audio: 'sub' }, now)).toBeNull()
  })

  it('does not read without a client or play id', async () => {
    expect(await readCachedStream(null, { playId: 'a', audio: 'sub' }, now)).toBeNull()
    const { client, reads } = stubClient({ row: { payload: {}, expires_at: fresh } })
    expect(await readCachedStream(client, { playId: '', audio: 'sub' }, now)).toBeNull()
    expect(reads).toHaveLength(0)
  })
})

describe('writeCachedStream', () => {
  const now = Date.parse('2026-11-17T21:00:00.000Z')

  it('upserts the payload with an expiry computed from the TTL', async () => {
    const { client, writes } = stubClient()
    const wrote = await writeCachedStream(client, { playId: '179876-6', audio: 'dub' }, { streamUrl: 'x' }, 120, now)

    expect(wrote).toBe(true)
    expect(writes[0].table).toBe('stream_cache')
    expect(writes[0].onConflict).toBe('play_id,audio')
    expect(writes[0].values).toEqual({
      play_id: '179876-6',
      audio: 'dub',
      payload: { streamUrl: 'x' },
      expires_at: new Date(now + 120_000).toISOString(),
    })
  })

  it('reports a rejected write instead of throwing', async () => {
    const { client } = stubClient({ writeError: { message: 'permission denied' } })
    expect(await writeCachedStream(client, { playId: 'a', audio: 'sub' }, { streamUrl: 'x' }, 60, now)).toBe(false)
  })

  it('reports a thrown write instead of throwing', async () => {
    const { client } = stubClient({ throwOnWrite: true })
    expect(await writeCachedStream(client, { playId: 'a', audio: 'sub' }, { streamUrl: 'x' }, 60, now)).toBe(false)
  })

  it('refuses to write without a client or a real play id', async () => {
    expect(await writeCachedStream(null, { playId: 'a', audio: 'sub' }, { x: 1 }, 60, now)).toBe(false)
    const { client, writes } = stubClient()
    expect(await writeCachedStream(client, { playId: '  ', audio: 'sub' }, { x: 1 }, 60, now)).toBe(false)
    expect(writes).toHaveLength(0)
  })
})
