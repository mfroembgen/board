// People on the board: WorkOS AuthKit access tokens minted for the board's URL as their resource.
import { HttpError } from '@vercel/board'
import type { Authenticate, HostPrincipal } from '@vercel/board/access'
import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from 'jose'

export type PeopleOptions = {
  /** The AuthKit origin, `https://<tenant>.authkit.app`: the tokens' `iss`. */
  issuer: string
  /** The board's URL: the one resource every client asks AuthKit for, so the tokens' only `aud`. */
  audience: string
  /** The email domain people must have verified. */
  domain: string
  /** Keys and HTTP, for tests. Default: the issuer's published JWKS, and the global fetch. */
  jwks?: JWTVerifyGetKey
  fetch?: typeof fetch
}

type Profile = { sub?: unknown; email?: unknown; email_verified?: unknown }

const SUB = /^user_[A-Za-z0-9]{1,100}$/

/**
 * Null for a token AuthKit didn't issue, so the next verifier gets it. An AuthKit token carries no
 * email, so after verifying it this reads the person's profile from userinfo, with the same token,
 * and keeps it until the token expires.
 */
export function authkitPeople(options: PeopleOptions): Authenticate {
  const jwks = options.jwks ?? createRemoteJWKSet(new URL('/oauth2/jwks', options.issuer))
  const userinfo = new URL('/oauth2/userinfo', options.issuer)
  const request = options.fetch ?? fetch
  const domain = `@${options.domain.toLowerCase()}`
  const known = new Map<string, { principal: HostPrincipal; until: number }>()

  return async ({ credential }) => {
    if (credential === null) return null
    let issuer: unknown
    try {
      issuer = decodeJwt(credential).iss
    } catch {
      return null
    }
    if (issuer !== options.issuer) return null

    const cached = known.get(credential)
    if (cached && cached.until > Date.now()) return cached.principal

    let sub: string
    let exp: number
    try {
      const { payload } = await jwtVerify(credential, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp'],
      })
      sub = payload.sub as string
      exp = payload.exp as number
    } catch (error) {
      if (error instanceof errors.JOSEError) throw new HttpError(401, 'unauthorized', `AuthKit token rejected: ${error.code}`)
      throw error
    }
    if (!SUB.test(sub)) throw new HttpError(401, 'unauthorized', 'AuthKit token without a user subject')

    const response = await request(userinfo, { headers: { authorization: `Bearer ${credential}` } })
    if (response.status === 401 || response.status === 403) throw new HttpError(401, 'unauthorized', 'AuthKit refused the token')
    if (!response.ok) throw new HttpError(502, 'identity_unavailable', `AuthKit userinfo answered ${response.status}`)
    const profile = (await response.json()) as Profile
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : ''
    if (profile.sub !== sub || profile.email_verified !== true || !email.endsWith(domain))
      throw new HttpError(403, 'forbidden', `only verified ${domain} accounts use this board`)

    // No `expiresAt`: the board would keep it with what a person schedules or registers, and cancel those
    // once a minutes-long access token expired. Each request still brings a token this verifies.
    const principal: HostPrincipal = { id: `authkit:user:${sub}`, kind: 'person', handle: email.slice(0, -domain.length) }
    for (const [token, entry] of known) if (entry.until <= Date.now()) known.delete(token)
    known.set(credential, { principal, until: exp * 1000 })
    return principal
  }
}
