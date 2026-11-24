// A self-hosted board: @vercel/board on a disk of its own, for people (AuthKit) and machines (OIDC grants).
import { board } from '@vercel/board'
import { oidcTokens, type OidcTokensOptions } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { decodeJwt } from 'jose'
import { authkitPeople, type PeopleOptions } from './people.ts'

export type AppOptions = {
  /** The board's public URL, which every token's audience must equal. */
  url: string
  /** Where the SQLite log and attachments live; `memory` keeps them in memory, for tests. */
  dir: string | { memory: true }
  people: Omit<PeopleOptions, 'audience'>
  /** Keys for grant-named issuers, for tests. Default: each issuer's published JWKS. */
  machines?: OidcTokensOptions
}

/**
 * Ends an event stream when the token that opened it expires. The board checks a token once per request,
 * and people carry no expiry of their own (what they schedule must outlive their token), so without
 * this an open stream would outlast the token by up to the board's stream limit.
 */
function untilExpiry(request: Request, response: Response): Response {
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) return response
  let exp: number | undefined
  try {
    exp = decodeJwt(request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '').exp
  } catch {
    return response
  }
  // Past setTimeout's 24.8-day limit the timer would fire at once; the board ends a stream far sooner anyway.
  const remaining = exp === undefined ? Infinity : exp * 1000 - Date.now()
  if (remaining > 2 ** 31 - 1) return response
  let end = () => {}
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({ start: (controller) => void (end = () => controller.terminate()) })
  // At expiry, terminate: the client sees a clean end at once, even with a write pending, and the pipe
  // fails and cancels the board's stream. The pipe settles however the stream ends, and clears the timer.
  const timer = setTimeout(() => {
    try {
      end()
    } catch {}
  }, Math.max(0, remaining))
  void response.body
    .pipeTo(writable)
    .catch(() => {})
    .finally(() => clearTimeout(timer))
  return new Response(readable, response)
}

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  const basePath = new URL(options.url).pathname
  const people = authkitPeople({ ...options.people, audience: options.url })
  // CI jobs and pods: OIDC tokens for the board's URL from an issuer a grant names, with what that grant gives.
  const machines = oidcTokens(options.machines)
  const team = board({
    backend: local(typeof options.dir === 'string' ? { dir: options.dir } : options.dir),
    url: options.url,
    basePath,
    authenticate: async (request) => (await people(request)) ?? (await machines(request)),
  })

  return async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/healthz') return new Response('ok')
    if (pathname === basePath || pathname.startsWith(`${basePath}/`)) return untilExpiry(request, await team.fetch(request))
    return new Response('not found', { status: 404 })
  }
}
