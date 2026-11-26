import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createApp } from '../src/app.ts'

const ORIGIN = 'https://board.test'
const URL_ = `${ORIGIN}/api/board`
const AUTHKIT = 'https://tenant.authkit.test'
const CLIENT = 'client_1'

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] })
const sign = (sub: string, lifetime: string, audience = URL_) =>
  new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setIssuer(AUTHKIT)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(lifetime)
    .sign(privateKey)
const DAY_MS = 24 * 60 * 60 * 1000
const emails: Record<string, string> = { user_ada: 'ada@example.com', user_eve: 'eve@elsewhere.test' }

function setup(options: { dir?: string; clientId?: string; url?: string } = {}) {
  const url = options.url ?? URL_
  const clients = new Set<string>(options.clientId ? [options.clientId] : [])
  const deleted = new Set<string>()
  const codes = new Map<string, { sub: string; challenge: string; lifetime: string }>()
  const refused = new Set<string>()
  const grants: string[] = []
  const down = new Map<string, () => Response | Promise<Response>>()
  const authkit = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input))
    const failing = down.get(pathname) ?? (pathname === '/oauth2/register' ? undefined : down.get('*'))
    if (failing) return failing()
    if (pathname === '/oauth2/register') {
      const id = `client_${clients.size + 1}`
      clients.add(id)
      return Response.json({ client_id: id })
    }
    if (pathname === '/oauth2/userinfo') {
      const sub = decodeJwt(new Headers(init?.headers).get('authorization')!.slice('Bearer '.length)).sub!
      return Response.json({ sub, email: emails[sub], email_verified: true })
    }
    const body = new URLSearchParams(String(init?.body))
    grants.push(body.get('grant_type')!)
    const client = body.get('client_id')!
    if (!clients.has(client) || deleted.has(client)) return Response.json({ error: 'invalid_client' }, { status: 401 })
    if (body.get('resource') !== url) return Response.json({ error: 'invalid_target' }, { status: 400 })
    if (body.get('grant_type') === 'refresh_token') {
      const refresh = body.get('refresh_token')!
      if (refused.has(refresh)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({ access_token: await sign(refresh.split(':')[1]!, '5m', url), refresh_token: refresh })
    }
    const issued = codes.get(body.get('code')!)
    const verifier = body.get('code_verifier') ?? ''
    if (!issued || createHash('sha256').update(verifier).digest('base64url') !== issued.challenge || body.get('redirect_uri') !== `${ORIGIN}/sign-in/callback`)
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    return Response.json({ access_token: await sign(issued.sub, issued.lifetime, url), refresh_token: `refresh:${issued.sub}` })
  }
  const app = createApp({
    url,
    dir: options.dir ?? { memory: true },
    people: { issuer: AUTHKIT, domain: 'example.com', jwks, fetch: authkit },
    ...(options.clientId ? { browser: { clientId: options.clientId } } : {}),
  })

  async function start(to = '/') {
    const response = await app(new Request(`${ORIGIN}/sign-in?to=${encodeURIComponent(to)}`))
    const pending = response.headers.getSetCookie()[0]!.split(';')[0]!
    return { response, pending, authorize: new URL(response.headers.get('location')!) }
  }

  type Started = Awaited<ReturnType<typeof start>>
  type Finish = { lifetime?: string; params?: Record<string, string>; cookie?: string }
  function finish({ pending, authorize }: Started, sub: string, options: Finish = {}) {
    const code = `code-${sub}-${authorize.searchParams.get('state')}`
    codes.set(code, { sub, challenge: authorize.searchParams.get('code_challenge')!, lifetime: options.lifetime ?? '5m' })
    const params = new URLSearchParams({ code, state: authorize.searchParams.get('state')!, iss: AUTHKIT, ...options.params })
    return app(new Request(`${ORIGIN}/sign-in/callback?${params}`, { headers: { cookie: options.cookie ?? pending } }))
  }

  async function callback(sub: string, options: Finish & { to?: string } = {}) {
    return finish(await start(options.to), sub, options)
  }

  const session = (response: Response) => response.headers.getSetCookie().find((line) => line.startsWith('__Host-board-session=') && !line.includes('Max-Age=0'))

  async function signIn(sub: string, lifetime?: string) {
    const line = session(await callback(sub, lifetime ? { lifetime } : {}))
    assert.ok(line, `${sub} got no session`)
    return line.split(';')[0]!
  }

  const fromPage = (cookie: string, path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    app(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        headers: { cookie, 'x-inspect-token': 'page', 'sec-fetch-site': 'same-origin', origin: ORIGIN, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    )

  return { app, start, finish, callback, session, signIn, fromPage, refused, grants, down, deleted, registrations: () => clients.size }
}

test('signing in starts at AuthKit with PKCE, for the board as the resource, in a sealed browser-bound cookie', async () => {
  const { response, authorize } = await setup().start()
  assert.equal(response.status, 302)
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${AUTHKIT}/oauth2/authorize`)
  const params = Object.fromEntries(authorize.searchParams)
  assert.equal(params.client_id, CLIENT)
  assert.equal(params.redirect_uri, `${ORIGIN}/sign-in/callback`)
  assert.equal(params.resource, URL_)
  assert.equal(params.scope, 'openid email offline_access')
  assert.equal(params.response_type, 'code')
  assert.equal(params.code_challenge_method, 'S256')
  assert.match(params.code_challenge ?? '', /^[\w-]{43}$/)
  assert.match(params.state ?? '', /^[\w-]{16,}$/)
  const cookie = response.headers.getSetCookie()[0]!
  assert.match(cookie, /^__Host-board-sign-in-[\w-]{12}=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/)
  assert.ok(!cookie.includes(params.state!), 'the cookie carries the state sealed')
})

test('a team member who signs in gets a host-only session cookie and returns where they started', async () => {
  const response = await setup().callback('user_ada', { to: '/tasks?state=ready' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), `${ORIGIN}/tasks?state=ready`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const cookies = response.headers.getSetCookie()
  assert.ok(cookies.some((line) => /^__Host-board-sign-in-[\w-]{12}=; Path=\/;.* Max-Age=0/.test(line)), 'the pending sign-in is cleared')
  const session = cookies.find((line) => line.startsWith('__Host-board-session='))
  assert.match(session ?? '', /^__Host-board-session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/)
  assert.ok(!session!.includes('refresh'), 'the refresh token stays on the server')
})

test('sign-in returns only to a path on this board', async () => {
  const inputs = [`/${'a'.repeat(2048)}`, '//evil.test/x', '/\\evil.test', 'https://evil.test/', '/.//evil.test/x', '/..//evil.test', '/%2e//evil.test', '/./\\evil.test', 'blob:https://board.test/x']
  for (const to of inputs) assert.equal((await setup().callback('user_ada', { to })).headers.get('location'), `${ORIGIN}/`, to)
})

test("a callback that isn't this browser's sign-in, from the board's issuer, starts no session", async () => {
  const { callback, session, start, app } = setup()
  for (const params of [{ state: 'another' }, { iss: 'https://evil.test' }] as Record<string, string>[]) {
    const response = await callback('user_ada', { params })
    assert.equal(response.status, 400, JSON.stringify(params))
    assert.equal(session(response), undefined)
  }
  const { authorize } = await start()
  const stray = await app(new Request(`${ORIGIN}/sign-in/callback?code=code-user_ada&state=${authorize.searchParams.get('state')}&iss=${AUTHKIT}`))
  assert.equal(stray.status, 400)
  assert.equal(session(stray), undefined)
})

test("a callback AuthKit can't finish asks to sign in again, with no session", async () => {
  const outages: Record<string, [string, () => Response]> = {
    unreachable: ['*', () => { throw new TypeError('fetch failed') }],
    userinfo: ['/oauth2/userinfo', () => new Response('unavailable', { status: 503 })],
  }
  for (const [outage, [path, answer]] of Object.entries(outages)) {
    const { callback, session, down } = setup()
    down.set(path, answer)
    const response = await callback('user_ada')
    assert.equal(response.status, 502, outage)
    assert.match(await response.text(), /href="\/sign-in\?to=/, outage)
    assert.equal(session(response), undefined, outage)
  }
})

test('an account outside the team domain gets no session', async () => {
  const { callback, session } = setup()
  const response = await callback('user_eve')
  assert.equal(response.status, 403)
  assert.match(await response.text(), /only verified @example\.com accounts/)
  assert.equal(session(response), undefined)
})

test('the board opens only for a session, and never asks who is posting', async () => {
  const { app, signIn } = setup()
  const signedOut = await app(new Request(`${ORIGIN}/?thread=812`))
  assert.equal(signedOut.status, 200)
  const signInPage = await signedOut.text()
  assert.match(signInPage, /href="\/sign-in\?to=%2F%3Fthread%3D812"/)
  assert.doesNotMatch(signInPage, /inspect-token/)

  const ada = await signIn('user_ada')
  const page = await app(new Request(`${ORIGIN}/?thread=812`, { headers: { cookie: ada } }))
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  const shell = await page.text()
  assert.match(shell, /<meta name="inspect-token" content="page">/)
  assert.doesNotMatch(shell, /inspect-named/)
})

test("a write through the page's proxy is the signed-in person's, and only the page's", async () => {
  const { fromPage, signIn } = setup()
  const ada = await signIn('user_ada')
  const post = { method: 'POST', body: JSON.stringify({ channel: 'general', text: 'hello' }), headers: { 'content-type': 'application/json' } }

  const written = await fromPage(ada, '/board/messages', post)
  assert.equal(written.status, 201, await written.clone().text())
  assert.match(JSON.stringify((await written.json()).message), /authkit:user:user_ada/)

  assert.equal((await fromPage('__Host-board-session=forged', '/board/messages', post)).status, 401)
  assert.equal((await fromPage(ada, '/board/messages', { ...post, headers: { ...post.headers, origin: 'https://evil.test' } })).status, 403)
  assert.equal((await fromPage(ada, '/board/messages', { ...post, headers: { ...post.headers, 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await fromPage(ada, '/board/messages', { ...post, headers: { ...post.headers, 'x-inspect-token': '' } })).status, 403)
})

test("an attachment goes up and comes back through the page's proxy", async () => {
  const { fromPage, signIn } = setup()
  const ada = await signIn('user_ada')
  const uploaded = await fromPage(ada, '/board/attachments', { method: 'POST', body: 'pixels', headers: { 'content-type': 'image/png', 'x-board-filename': 'a.png' } })
  assert.equal(uploaded.status, 201, await uploaded.clone().text())
  const { attachment } = await uploaded.json()
  assert.equal(attachment.name, 'a.png')
  const downloaded = await fromPage(ada, `/board/attachments/${attachment.id}`)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'image/png')
  assert.match(downloaded.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.match(downloaded.headers.get('content-disposition') ?? '', /a\.png/)
  assert.equal(await downloaded.text(), 'pixels')
})

test('an access token near its expiry is refreshed before the proxy sends it, and a refused refresh signs out', async () => {
  const { fromPage, signIn, grants, refused, down } = setup()
  const ada = await signIn('user_ada', '30s')
  assert.equal((await fromPage(ada, '/board/me')).status, 200)
  assert.equal((await fromPage(ada, '/board/me')).status, 200)
  assert.deepEqual(grants, ['authorization_code', 'refresh_token'])

  const stale = await signIn('user_ada', '30s')
  down.set('/oauth2/token', () => Response.json({ error: 'slow_down' }, { status: 429 }))
  assert.equal((await fromPage(stale, '/board/me')).status, 502)
  down.clear()
  assert.equal((await fromPage(stale, '/board/me')).status, 200)

  refused.add('refresh:user_ada')
  const short = await signIn('user_ada', '30s')
  const response = await fromPage(short, '/board/me')
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'signed_out')
})

test('signing out ends the session, and only the board itself can sign you out', async () => {
  const { app, fromPage, signIn } = setup()
  const ada = await signIn('user_ada')
  const signOut = (origin: string) => app(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: ada, origin } }))

  const form = await app(new Request(`${ORIGIN}/sign-out`, { headers: { cookie: ada } }))
  assert.match(await form.text(), /<form method="post" action="\/sign-out">/)
  assert.equal(form.headers.get('referrer-policy'), 'same-origin', 'a form post under no-referrer sends Origin: null')

  assert.equal((await signOut('https://evil.test')).status, 403)
  assert.equal((await fromPage(ada, '/board/me')).status, 200)

  const response = await signOut(ORIGIN)
  assert.equal(response.status, 303)
  assert.match(response.headers.getSetCookie()[0] ?? '', /^__Host-board-session=; .*Max-Age=0/)
  assert.equal((await fromPage(ada, '/board/me')).status, 401)
})

test('a session ends 30 days after sign-in, however often it is used', async (t) => {
  t.after(() => mock.timers.reset())
  const { fromPage, signIn } = setup()
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const ada = await signIn('user_ada')
  mock.timers.tick(29 * DAY_MS)
  assert.equal((await fromPage(ada, '/board/me')).status, 200)
  mock.timers.tick(2 * DAY_MS)
  assert.equal((await fromPage(ada, '/board/me')).status, 401)
})

test('signing out ends the streams that session has open', async () => {
  const { app, fromPage, signIn } = setup()
  const ada = await signIn('user_ada')
  const stream = await fromPage(ada, '/board/events', { headers: { accept: 'text/event-stream' } })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /event-stream/)
  const reader = stream.body!.getReader()
  const ended = (async () => {
    for (;;) if ((await reader.read()).done) return 'ended'
  })().catch(() => 'ended')

  await app(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: ada, origin: ORIGIN } }))
  const outcome = await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000, 'still open'))])
  assert.equal(outcome, 'ended')
})

test('a refresh that finishes after the 30 days answers as signed out', async (t) => {
  t.after(() => mock.timers.reset())
  const { fromPage, signIn, down } = setup()
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const ada = await signIn('user_ada', '30s')
  mock.timers.tick(30 * DAY_MS - 1000)
  down.set('/oauth2/token', async () => {
    mock.timers.tick(2000)
    return Response.json({ access_token: await sign('user_ada', '5m'), refresh_token: 'refresh:user_ada' })
  })
  assert.equal((await fromPage(ada, '/board/me')).status, 401)
})

test('an open stream ends when its session reaches 30 days', async (t) => {
  t.after(() => mock.timers.reset())
  const { fromPage, signIn } = setup()
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const ada = await signIn('user_ada')
  mock.timers.tick(30 * DAY_MS - 60_000)
  const stream = await fromPage(ada, '/board/events', { headers: { accept: 'text/event-stream' } })
  assert.equal(stream.status, 200)
  const reader = stream.body!.getReader()
  const ended = (async () => {
    for (;;) if ((await reader.read()).done) return 'ended'
  })().catch(() => 'ended')
  mock.timers.tick(61_000)
  mock.timers.reset()
  const outcome = await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000, 'still open'))])
  assert.equal(outcome, 'ended')
})

test('AuthKit refusing the client signs out; an outage keeps the session and asks to try again', async () => {
  const { app, fromPage, signIn, down } = setup()
  const refused = await signIn('user_ada', '30s')
  down.set('/oauth2/token', () => Response.json({ error: 'invalid_client' }, { status: 401 }))
  assert.equal((await fromPage(refused, '/board/me')).status, 401)
  down.clear()
  assert.equal((await fromPage(refused, '/board/me')).status, 401)

  const unauthorized = await signIn('user_ada', '30s')
  down.set('/oauth2/token', () => Response.json({ error: 'unauthorized_client' }, { status: 400 }))
  assert.equal((await fromPage(unauthorized, '/board/me')).status, 401)
  down.clear()

  const kept = await signIn('user_ada', '30s')
  down.set('/oauth2/token', () => new Response('unavailable', { status: 503 }))
  const outage = await app(new Request(`${ORIGIN}/tasks`, { headers: { cookie: kept } }))
  assert.equal(outage.status, 502)
  const retry = await outage.text()
  assert.match(retry, /Try again/)
  assert.match(retry, /<form method="post" action="\/sign-out">/)
  assert.deepEqual(outage.headers.getSetCookie(), [])
  down.clear()
  const page = await app(new Request(`${ORIGIN}/tasks`, { headers: { cookie: kept } }))
  assert.match(await page.text(), /inspect-token/)
})

test('trying again after a failed sign-in still lands where it started', async () => {
  const { callback, down } = setup()
  down.set('/oauth2/userinfo', () => new Response('unavailable', { status: 503 }))
  const failed = await callback('user_ada', { to: '/tasks?state=ready' })
  assert.equal(failed.status, 502)
  const retry = new URL((await failed.text()).match(/href="([^"]+)"/)![1]!.replaceAll('&#39;', "'"), ORIGIN)
  down.clear()
  const landed = await callback('user_ada', { to: retry.searchParams.get('to')! })
  assert.equal(landed.headers.get('location'), `${ORIGIN}/tasks?state=ready`)
})

test("an API path that would shadow the browser's routes is refused at boot", () => {
  const people = { issuer: AUTHKIT, domain: 'example.com', jwks }
  for (const path of ['', '/board', '/board/api', '/sign-in', '/app.js', '/tasks', '/settings/api', '/c', '/t', '/inbox'])
    assert.throws(() => createApp({ url: `${ORIGIN}${path}`, dir: { memory: true }, people }), /collides with the browser's routes/, path)
})

test('a sign-in in one tab leaves the sign-in pending in another', async () => {
  const { start, finish, session } = setup()
  const first = await start('/first')
  const second = await start('/second')
  const cookie = `${first.pending}; ${second.pending}`

  const stray = await finish({ ...first, authorize: new URL(first.authorize.href.replace(/state=[^&]+/, 'state=another')) }, 'user_ada', { cookie })
  assert.equal(stray.status, 400)
  assert.deepEqual(stray.headers.getSetCookie(), [])

  const one = await finish(first, 'user_ada', { cookie })
  assert.equal(one.headers.get('location'), `${ORIGIN}/first`)
  assert.ok(one.headers.getSetCookie().some((line) => line.startsWith(`${first.pending.split('=')[0]}=;`)))
  assert.ok(!one.headers.getSetCookie().some((line) => line.startsWith(`${second.pending.split('=')[0]}=`)))
  const two = await finish(second, 'user_ada', { cookie })
  assert.equal(two.headers.get('location'), `${ORIGIN}/second`)
  assert.ok(session(two))
})

test('a registered client AuthKit rejects tells the operator what to do, and changes nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'board-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { callback, start, signIn, deleted, session } = setup({ dir })
  await signIn('user_ada')
  const forged = await callback('user_ada', { params: { error: 'invalid_client' } })
  assert.equal(forged.status, 400)
  assert.equal(session(forged), undefined)

  deleted.add('client_1')
  const rejected = await callback('user_ada')
  assert.equal(rejected.status, 502)
  assert.match(await rejected.text(), /delete authkit-client\.json in BOARD_DIR and restart/)
  assert.equal(session(rejected), undefined)
  assert.match(await readFile(join(dir, 'authkit-client.json'), 'utf8'), /client_1/)
  assert.equal((await start()).authorize.searchParams.get('client_id'), 'client_1')
})

test('a configured client AuthKit refuses tells the operator what to fix', async () => {
  const { callback, deleted } = setup({ clientId: 'client_fixed' })
  deleted.add('client_fixed')
  const response = await callback('user_ada')
  assert.equal(response.status, 502)
  assert.match(await response.text(), /AUTHKIT_CLIENT_ID client_fixed/)
})

test('a session that ends while a refresh fails answers as signed out, not as try again', async (t) => {
  t.after(() => mock.timers.reset())
  const { app, fromPage, signIn, down } = setup()
  const ada = await signIn('user_ada', '30s')
  down.set('/oauth2/token', async () => {
    await app(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: ada, origin: ORIGIN } }))
    return new Response('unavailable', { status: 503 })
  })
  assert.equal((await fromPage(ada, '/board/me')).status, 401)

  down.clear()
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const late = await signIn('user_ada', '30s')
  mock.timers.tick(30 * DAY_MS - 1000)
  down.set('/oauth2/token', () => {
    mock.timers.tick(2000)
    return new Response('unavailable', { status: 503 })
  })
  const page = await app(new Request(`${ORIGIN}/`, { headers: { cookie: late } }))
  assert.equal(page.status, 200)
  assert.match(await page.text(), /href="\/sign-in\?to=/)
  assert.deepEqual(page.headers.getSetCookie(), [], 'a stale request leaves the cookie to whatever session the browser has now')
})

test("a refresh answer that isn't an OAuth error keeps the session", async () => {
  const { fromPage, signIn, down } = setup()
  const ada = await signIn('user_ada', '30s')
  const answers = [
    () => new Response('<h1>blocked</h1>', { status: 403 }),
    () => new Response(null, { status: 404 }),
    () => Response.json({ error: 'Bad Request', statusCode: 400 }, { status: 400 }),
    () => Response.json({ error: '' }, { status: 400 }),
    () => Response.json({ error: 'invalid_request' }, { status: 400 }),
  ]
  for (const answer of answers) {
    down.set('/oauth2/token', answer)
    assert.equal((await fromPage(ada, '/board/me')).status, 502)
  }
  down.clear()
  assert.equal((await fromPage(ada, '/board/me')).status, 200)
})

test('signing in again in another tab ends the session the browser had', async () => {
  const { app, start, finish, fromPage, session, signIn } = setup()
  const first = await signIn('user_ada')
  const second = await start()
  const line = session(await finish(second, 'user_ada', { cookie: `${second.pending}; ${first}` }))
  const next = line!.split(';')[0]!
  assert.equal((await fromPage(first, '/board/me')).status, 401)
  assert.equal((await fromPage(next, '/board/me')).status, 200)
  await app(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: next, origin: ORIGIN } }))
  assert.equal((await fromPage(next, '/board/me')).status, 401)
})

test('a board URL with a trailing slash signs in and proxies, with that URL as the resource', async () => {
  const url = `${ORIGIN}/api/board/`
  const { app, start, fromPage, signIn } = setup({ url })
  assert.equal((await app(new Request(`${ORIGIN}/api/board/channels`))).status, 401)
  assert.equal((await start()).authorize.searchParams.get('resource'), url)
  const ada = await signIn('user_ada')
  assert.equal((await fromPage(ada, '/board/me')).status, 200)
  const post = { method: 'POST', body: JSON.stringify({ channel: 'general', text: 'hi' }), headers: { 'content-type': 'application/json' } }
  assert.equal((await fromPage(ada, '/board/messages', post)).status, 201)
})

test('a return path too big for the pending cookie falls back to the board', async () => {
  const { start, finish } = setup()
  for (const to of [`/${'é'.repeat(520)}`, `/${'"'.repeat(2047)}`]) {
    const started = await start(to)
    assert.ok(started.pending.length <= 3800, `${to.length} characters made a ${started.pending.length}-byte cookie`)
    assert.equal((await finish(started, 'user_ada')).headers.get('location'), `${ORIGIN}/`)
  }
})

test("a client the board can't save is kept in memory, and the browser never sees why", async (t) => {
  t.mock.method(console, 'error', () => {})
  const dir = await mkdtemp(join(tmpdir(), 'board-'))
  t.after(() => chmod(dir, 0o700).then(() => rm(dir, { recursive: true, force: true })))
  await chmod(dir, 0o500)
  const { start, registrations } = setup({ dir })
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await start()).response.status, 302)
  assert.equal(registrations(), 1)

  const { app, down } = setup()
  down.set('/oauth2/register', () => new Response(`refused for ${dir}`, { status: 500 }))
  const failed = await app(new Request(`${ORIGIN}/sign-in`))
  assert.equal(failed.status, 502)
  const page = await failed.text()
  assert.ok(!page.includes(dir) && !page.includes('refused for'), page)
})
