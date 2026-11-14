/**
 * ani provider status (node runtime, cron-secret guarded).
 *
 * Answers what the switch is doing on THIS serverless instance: flag, rollout
 * percentage, dub switch, breaker and limiter state, cache size, the last
 * attempts and the counters. No secrets, no URLs, no tokens.
 *
 * Counters are per instance. Vercel runs several, so read this as a sample of
 * the fleet, not a global total.
 */

import { getAniStatus } from '@/lib/ani/client'
import { authorizeCron } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const denied = authorizeCron(request)
  if (denied) return denied

  return Response.json(
    {
      ...getAniStatus(),
      note:
        'Counters and caches are per serverless instance. The real upstream ceiling is the ' +
        'ani-api rate limit of 60 req/min per key, and Play uses its own key.',
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
