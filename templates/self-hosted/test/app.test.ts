// The board's door: who gets in, and as whom. Everything past it is @vercel/board's own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { createApp } from '../src/app.ts'

const URL_ = 'https://board.test/api/board'
const AUTHKIT = 'https://tenant.authkit.test'
const GITLAB = 'https://gitlab.test'

async function issuer(iss: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] })
  const sign = (claims: JWTPayload, aud = URL_) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  return { jwks, sign }
}

const authkit = await issuer(AUTHKIT)
const gitlab = await issuer(GITLAB)
const emails: Record<string, string> = { user_ada: 'ada@example.com', user_eve: 'eve@elsewhere.test' }
const app = createApp({
  url: URL_,
  dir: { memory: true },
  people: {
    issuer: AUTHKIT,
    domain: 'example.com',
    jwks: authkit.jwks,
    fetch: async (_url, init) => {
      const token = new Headers(init?.headers).get('authorization')!.slice('Bearer '.length)
      const sub = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub as string
      return Response.json({ sub, email: emails[sub], email_verified: true })
    },
  },
  machines: { oidc: { [GITLAB]: gitlab.jwks } },
})

const call = (token: string, method: string, path: string, body?: unknown) =>
  app(new Request(`${URL_}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))

test('a verified team member posts as themselves', async () => {
  const response = await call(await authkit.sign({ sub: 'user_ada' }), 'POST', '/messages', { channel: 'general', text: 'hello' })
  assert.equal(response.status, 201)
  const { message } = await response.json()
  assert.match(JSON.stringify(message), /authkit:user:user_ada/)
})

test('an account outside the team domain is refused', async () => {
  const response = await call(await authkit.sign({ sub: 'user_eve' }), 'GET', '/channels')
  assert.equal(response.status, 403)
})

test('an AuthKit token for another resource is refused', async () => {
  const response = await call(await authkit.sign({ sub: 'user_ada' }, 'https://claimy.test/mcp'), 'GET', '/channels')
  assert.equal(response.status, 401)
})

test('a CI job gets only what a grant gives it', async () => {
  const job = await gitlab.sign({ sub: 'project_path:acme/web:ref_type:branch:ref:main', project_id: '42' })
  assert.notEqual((await call(job, 'POST', '/messages', { channel: 'ci', text: 'built' })).status, 201)

  const ada = await authkit.sign({ sub: 'user_ada' })
  const grant = await call(ada, 'POST', '/grants', {
    principals: [{ kind: 'oidc', issuer: GITLAB, claims: { sub: 'project_path:acme/web:*' } }],
    can: { 'ci/': ['post'] },
  })
  assert.equal(grant.status, 200, await grant.clone().text())

  assert.equal((await call(job, 'POST', '/messages', { channel: 'ci/board', text: 'built' })).status, 201)
  assert.notEqual((await call(job, 'POST', '/messages', { channel: 'general', text: 'built' })).status, 201)
})
