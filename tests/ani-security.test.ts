import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Security invariants for the ani provider.
 *
 * (a) the signed handles never carry the key (covered in the route tests, and
 *     re-checked here on the token helpers themselves),
 * (c) the production build output must not contain the key used to build it,
 * (e) nothing on the edge runtime may import lib/ani, because the key lives in
 *     the node process environment only.
 */

const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const routeFiles = walk(path.join(ROOT, 'app')).filter((file) => file.endsWith(`${path.sep}route.ts`))

function read(file: string) {
  return readFileSync(file, 'utf8')
}

describe('edge runtime containment', () => {
  it('has no edge route importing lib/ani', () => {
    const edgeRoutes = routeFiles.filter((file) => /export const runtime = 'edge'/.test(read(file)))
    expect(edgeRoutes.length).toBeGreaterThan(0)
    for (const file of edgeRoutes) {
      expect(read(file)).not.toMatch(/@\/lib\/ani/)
    }
  })

  it('only lets nodejs route handlers import lib/ani', () => {
    const importers = [
      ...routeFiles,
      ...walk(path.join(ROOT, 'lib')).filter((file) => file.endsWith('.ts')),
    ].filter((file) => /@\/lib\/ani/.test(read(file)))

    expect(importers.length).toBeGreaterThan(0)
    for (const file of importers) {
      if (!file.endsWith(`${path.sep}route.ts`)) continue
      expect(read(file)).toMatch(/export const runtime = 'nodejs'/)
    }
  })

  it('never exposes an ani variable with a NEXT_PUBLIC_ prefix', () => {
    const sources = [
      ...walk(path.join(ROOT, 'lib', 'ani')),
      ...walk(path.join(ROOT, 'app', 'api', 'proxy', 'ani-subtitle')),
      ...walk(path.join(ROOT, 'app', 'api', 'admin', 'ani-status')),
    ].filter((file) => file.endsWith('.ts'))
    for (const file of sources) {
      // A NEXT_PUBLIC_ANI_* variable would be inlined into the browser bundle.
      expect(read(file)).not.toContain('NEXT_PUBLIC_ANI')
      expect(read(file)).not.toMatch(/process\.env\.NEXT_PUBLIC/)
    }
  })
})

describe('build output', () => {
  const sentinel = process.env.ANI_KEY_SENTINEL
  const buildDir = path.join(ROOT, '.next')

  it.skipIf(!sentinel || !existsSync(buildDir))('never contains the key it was built with', () => {
    // .next/cache is the local turbopack compilation cache: it is never uploaded
    // or served, and it does record the environment a build ran with. The trees
    // that actually ship (.next/static, .next/server) must stay clean, and so
    // must every other file outside that cache.
    const files = walk(buildDir).filter(
      (file) => !file.endsWith('.map') && !path.relative(buildDir, file).startsWith(`cache${path.sep}`),
    )
    const hits: string[] = []
    for (const file of files) {
      let text = ''
      try {
        text = readFileSync(file, 'latin1')
      } catch {
        continue
      }
      if (text.includes(sentinel as string)) hits.push(path.relative(ROOT, file))
    }
    expect(hits).toEqual([])
  })
})
