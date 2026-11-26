import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Board } from '@vercel/board'
import { inspector } from '@vercel/board/inspect'
import { decodeJwt, EncryptJWT, jwtDecrypt } from 'jose'

export type BrowserOptions = {
  url: string
  issuer: string
  team: Board
  serve: (request: Request) => Promise<Response>
  dir: string | null
  clientId?: string
  label?: string
  fetch?: typeof fetch
}

type Tokens = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}
type Session = {
  clientId: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  endsAt: number
  ended: AbortController
  deadline?: ReturnType<typeof setTimeout>
  refreshing?: Promise<string | null>
}
type SavedClient = { issuer?: string; redirectUri?: string; clientId?: unknown }
type Pending = { state: string; verifier: string; to: string; clientId: string }
type Refusal = { status: number; why: string }

const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const REFRESH_AHEAD_MS = 60_000
const PAGE_TOKEN = 'page'
const PROXIED_HEADERS = ['content-type', 'accept', 'x-board-filename', 'x-board-profile']
const RETURNED_HEADERS = ['content-type', 'content-disposition', 'content-security-policy']
const BROWSER_ROUTES = ['/board', '/app.js', '/sign-in', '/sign-out', '/healthz', '/tasks', '/settings', '/c', '/t', '/inbox']
const RETURN_PATH_MAX = 2048
const PENDING_COOKIE_MAX = 3800
const TIMER_MAX_MS = 2 ** 31 - 1
const TERMINAL_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client'])
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const SIGN_OUT_FORM = '<form method="post" action="/sign-out"><button type="submit">Sign out</button></form>'
const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)
const terminal = (status: number, error: unknown) => (status === 400 || status === 401) && typeof error === 'string' && TERMINAL_ERRORS.has(error)
const webUrl = (url: URL) => url.protocol === 'http:' || url.protocol === 'https:'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export function browser(options: BrowserOptions): (request: Request) => Promise<Response> {
  const board = new URL(options.url)
  const base = board.pathname.replace(/\/+$/, '')
  if (base === '' || BROWSER_ROUTES.some((route) => under(route, base) || under(base, route)))
    throw new Error(`BOARD_PUBLIC_URL's path ${base || '/'} collides with the browser's routes (/, ${BROWSER_ROUTES.join(', ')}): serve the API under another path, such as /api/board`)
  const origin = board.origin
  const api = `${origin}${base}`
  const secure = board.protocol === 'https:'
  const sessionCookie = `${secure ? '__Host-' : ''}board-session`
  const pendingCookie = (state: string) => `${secure ? '__Host-' : ''}board-sign-in-${createHash('sha256').update(state).digest('base64url').slice(0, 12)}`
  const clientFile = options.dir === null ? null : join(options.dir, 'authkit-client.json')
  const redirectUri = `${origin}/sign-in/callback`
  const authkit = options.fetch ?? fetch
  const label = options.label ?? 'Sign in'
  const key = crypto.getRandomValues(new Uint8Array(32))
  const sessions = new Map<string, Session>()
  const inspect = inspector({ board: options.team, basePath: '' })

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

  const readCookie = (request: Request, name: string) =>
    request.headers
      .get('cookie')
      ?.split(/;\s*/)
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null

  const html = (status: number, body: string, headers: Headers = new Headers()) => {
    const page = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY, 'referrer-policy': 'same-origin' }
    for (const [name, value] of Object.entries({ ...NO_STORE, ...page })) headers.set(name, value)
    const markup = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>board</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#111}main{text-align:center;padding:16px;max-width:28rem}a.button,button{display:inline-block;font:inherit;padding:.6em 1.4em;border-radius:6px;border:0;background:#111;color:#fff;text-decoration:none;cursor:pointer}p.note{color:#666}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}a.button,button{background:#eee;color:#111}p.note{color:#999}}</style></head><body><main>${body}</main></body></html>`
    return new Response(markup, { status, headers })
  }

  const signInPage = (status: number, to: string, note?: string, headers?: Headers) =>
    html(
      status,
      `<h1>board</h1>${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}<a class="button" href="/sign-in?to=${escapeHtml(encodeURIComponent(to))}">${escapeHtml(label)}</a>`,
      headers,
    )

  const json = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: NO_STORE })

  const within = (to: string | null) => {
    const target = (to?.length ?? 0) > RETURN_PATH_MAX ? null : URL.parse(to ?? '/', origin)
    const safe = target !== null && target.origin === origin && webUrl(target) && !target.pathname.startsWith('//')
    return safe ? target.href : `${origin}/`
  }

  let registering: Promise<string> | null = null
  const clientId = () =>
    options.clientId !== undefined
      ? Promise.resolve(options.clientId)
      : (registering ??= register().catch((error: unknown) => {
          registering = null
          throw error
        }))

  async function readSaved(file: string): Promise<string | null> {
    const saved = (await readFile(file, 'utf8').then(JSON.parse, () => null)) as SavedClient | null
    const matches = saved?.issuer === options.issuer && saved.redirectUri === redirectUri
    return matches && typeof saved.clientId === 'string' ? saved.clientId : null
  }

  async function register(): Promise<string> {
    const saved = clientFile === null ? null : await readSaved(clientFile)
    if (saved !== null) return saved
    const response = await authkit(new URL('/oauth2/register', options.issuer), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: `board at ${board.host}`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    if (!response.ok) throw new Error(`AuthKit registration answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const registered = ((await response.json()) as { client_id: string }).client_id
    if (clientFile !== null && options.dir !== null)
      await keep(options.dir, clientFile, registered).catch((error: unknown) => console.error('board: AuthKit client kept in memory only', error))
    return registered
  }

  async function keep(dir: string, file: string, registered: string) {
    await mkdir(dir, { recursive: true })
    const temporary = `${file}.${process.pid}`
    await writeFile(temporary, JSON.stringify({ issuer: options.issuer, redirectUri, clientId: registered }), { mode: 0o600 })
    await rename(temporary, file)
  }

  const seal = (pending: Pending) =>
    new EncryptJWT(pending)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setExpirationTime('10m')
      .encrypt(key)

  const exchange = async (body: Record<string, string>) => {
    const response = await authkit(new URL('/oauth2/token', options.issuer), { method: 'POST', body: new URLSearchParams({ ...body, resource: options.url }) })
    return { response, tokens: (await response.json().catch(() => ({}))) as Tokens }
  }

  const kept = (tokens: Tokens & { access_token: string }, refreshToken: string | null) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: (decodeJwt(tokens.access_token).exp ?? Date.now() / 1000 + (tokens.expires_in ?? 300)) * 1000,
  })

  function end(id: string) {
    const session = sessions.get(id)
    clearTimeout(session?.deadline)
    session?.ended.abort()
    sessions.delete(id)
  }

  function armDeadline(id: string, session: Session) {
    const remaining = session.endsAt - Date.now()
    if (remaining <= 0) return end(id)
    session.deadline = setTimeout(() => armDeadline(id, session), Math.min(remaining, TIMER_MAX_MS))
    session.deadline.unref()
  }

  const current = (request: Request) => {
    const id = readCookie(request, sessionCookie)
    const session = id === null ? undefined : sessions.get(id)
    if (id === null || session === undefined) return null
    if (session.endsAt > Date.now()) return { id, session }
    end(id)
    return null
  }

  async function liveToken(signedIn: { id: string; session: Session }): Promise<string | null | undefined> {
    const token = await accessToken(signedIn).catch(() => undefined)
    if (token === null) return null
    if (sessions.get(signedIn.id) === signedIn.session && signedIn.session.endsAt > Date.now()) return token
    end(signedIn.id)
    return null
  }

  function accessToken({ id, session }: { id: string; session: Session }): Promise<string | null> {
    if (session.expiresAt - REFRESH_AHEAD_MS > Date.now()) return Promise.resolve(session.accessToken)
    return (session.refreshing ??= refresh(id, session).finally(() => {
      session.refreshing = undefined
    }))
  }

  async function refresh(id: string, session: Session): Promise<string | null> {
    if (session.refreshToken === null) {
      end(id)
      return null
    }
    const { response, tokens } = await exchange({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId })
    if (!response.ok && terminal(response.status, tokens.error)) {
      end(id)
      return null
    }
    if (!response.ok || !tokens.access_token) throw new Error(`AuthKit answered ${response.status} to a refresh`)
    Object.assign(session, kept({ ...tokens, access_token: tokens.access_token }, session.refreshToken))
    return session.accessToken
  }

  async function signIn(url: URL): Promise<Response> {
    const to = within(url.searchParams.get('to'))
    let client: string
    try {
      client = await clientId()
    } catch (error) {
      console.error('board: AuthKit client registration failed', error)
      return signInPage(502, to, "AuthKit couldn't register this board as a client. Try again later.")
    }
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(16).toString('base64url')
    const name = pendingCookie(state)
    const pending: Pending = { state, verifier, to, clientId: client }
    let sealed = await seal(pending)
    if (name.length + 1 + sealed.length > PENDING_COOKIE_MAX) sealed = await seal({ ...pending, to: `${origin}/` })
    const authorize = new URL('/oauth2/authorize', options.issuer)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: redirectUri,
      scope: 'openid email offline_access',
      state,
      resource: options.url,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return new Response(null, { status: 302, headers: { ...NO_STORE, location: authorize.href, 'set-cookie': cookie(name, sealed, 600) } })
  }

  async function unseal(sealed: string | null): Promise<Pending | null> {
    if (sealed === null) return null
    const opened = await jwtDecrypt(sealed, key).catch(() => null)
    return opened === null ? null : (opened.payload as Pending)
  }

  function prune() {
    for (const [id, session] of sessions) if (session.endsAt <= Date.now()) end(id)
  }

  async function signedInAs(code: string, pending: Pending): Promise<Refusal | (Tokens & { access_token: string })> {
    const body = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: pending.clientId, code_verifier: pending.verifier }
    const exchanged = await exchange(body).catch(() => null)
    if (exchanged === null) return { status: 502, why: "AuthKit didn't answer. Sign in again." }
    const { response, tokens } = exchanged
    if (!response.ok && tokens.error === 'invalid_client') return { status: 502, why: rejectedClient(pending.clientId) }
    if (!response.ok || !tokens.access_token)
      return { status: 502, why: `AuthKit didn't issue a token: ${tokens.error_description ?? tokens.error ?? response.status}` }
    const me = await options.serve(new Request(`${api}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))
    if (me.ok) return { ...tokens, access_token: tokens.access_token }
    const said = ((await me.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message
    if (me.status === 401 || me.status === 403) return { status: me.status, why: said ?? `The board refused the sign-in (${me.status}).` }
    return { status: 502, why: `The board couldn't check your account (${said ?? me.status}). Sign in again.` }
  }

  const rejectedClient = (client: string) =>
    options.clientId !== undefined
      ? `AuthKit rejected this board's client, AUTHKIT_CLIENT_ID ${client}. An operator must set it to a public client whose redirect URI is ${redirectUri}, or unset it so the board registers one.`
      : `AuthKit rejected this board's registered client ${client}. An operator must delete authkit-client.json in BOARD_DIR and restart the board, which then registers a new one.`

  async function callback(request: Request, url: URL): Promise<Response> {
    const params = url.searchParams
    const state = params.get('state') ?? ''
    const pending = await unseal(readCookie(request, pendingCookie(state)))
    if (!pending || pending.state !== state)
      return signInPage(400, '/', 'This sign-in expired, began in another browser, or belongs to another sign-in. Sign in again.')
    const headers = new Headers({ 'set-cookie': cookie(pendingCookie(state), '', 0) })
    const refuse = (status: number, why: string) => signInPage(status, pending.to, why, headers)
    if (params.get('iss') !== options.issuer) return refuse(400, `The callback names issuer ${params.get('iss') ?? '(none)'}, not ${options.issuer}.`)
    const error = params.get('error')
    if (error !== null) {
      const hint = error === 'invalid_target' ? ` Register ${options.url} as a resource indicator in AuthKit.` : ''
      return refuse(400, `AuthKit refused the sign-in: ${params.get('error_description') ?? error}.${hint}`)
    }
    const code = params.get('code')
    if (code === null) return refuse(400, 'The callback carries no code. Sign in again.')
    const tokens = await signedInAs(code, pending)
    if ('why' in tokens) return refuse(tokens.status, tokens.why)
    const replaced = readCookie(request, sessionCookie)
    if (replaced !== null) end(replaced)
    const id = randomBytes(32).toString('base64url')
    prune()
    const session: Session = { clientId: pending.clientId, ...kept(tokens, null), endsAt: Date.now() + SESSION_MS, ended: new AbortController() }
    sessions.set(id, session)
    armDeadline(id, session)
    headers.append('set-cookie', cookie(sessionCookie, id, SESSION_MS / 1000))
    for (const [name, value] of Object.entries({ ...NO_STORE, location: pending.to })) headers.set(name, value)
    return new Response(null, { status: 303, headers })
  }

  function signOut(request: Request): Response {
    if (request.headers.get('origin') !== origin) return json(403, 'forbidden', "sign out from the board's own page")
    const signedIn = current(request)
    if (signedIn) end(signedIn.id)
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: '/', 'set-cookie': cookie(sessionCookie, '', 0) } })
  }

  async function proxy(request: Request, url: URL): Promise<Response> {
    const reading = request.method === 'GET' || request.method === 'HEAD'
    const site = request.headers.get('sec-fetch-site')
    if (request.headers.get('x-inspect-token') !== PAGE_TOKEN || (site !== null && site !== 'same-origin') || (!reading && request.headers.get('origin') !== origin))
      return json(403, 'forbidden', "the board is reachable here only from the inspector's own page")
    const target = new URL(`${api}${url.pathname.slice('/board'.length) || '/'}${url.search}`)
    if (target.origin !== origin || !under(target.pathname, base))
      return json(400, 'bad_path', 'no relative paths')
    const signedIn = current(request)
    const token = signedIn === null ? null : await liveToken(signedIn)
    if (token === undefined) return json(502, 'identity_unavailable', "AuthKit didn't refresh your sign-in; try again")
    if (token === null || signedIn === null) return json(401, 'signed_out', 'you are signed out: reload the page to sign in again')
    const headers = new Headers({ authorization: `Bearer ${token}` })
    for (const name of PROXIED_HEADERS) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    const init: RequestInit & { duplex: 'half' } = { method: request.method, headers, body: reading ? null : request.body, duplex: 'half', signal: AbortSignal.any([request.signal, signedIn.session.ended.signal]) }
    const upstream = await options.serve(new Request(target, init))
    const returned = new Headers({ ...NO_STORE, 'content-type': 'application/json' })
    for (const name of RETURNED_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) returned.set(name, value)
    }
    return new Response(upstream.body, { status: upstream.status, headers: returned })
  }

  async function home(request: Request, url: URL): Promise<Response> {
    const signedIn = current(request)
    const token = signedIn === null ? null : await liveToken(signedIn)
    if (token === null) return signInPage(200, `${url.pathname}${url.search}`)
    if (token === undefined) {
      const again = `<a class="button" href="${escapeHtml(within(`${url.pathname}${url.search}`))}">Try again</a>`
      return html(502, `<h1>board</h1><p class="note">AuthKit didn't renew your sign-in. Try again in a moment.</p>${again}${SIGN_OUT_FORM}`)
    }
    const page = await inspect(new Request(new URL('/', origin)))
    const shell = (await page.text()).replace(/<meta name="inspect-named"[^>]*>\n?/, '')
    return new Response(request.method === 'HEAD' ? null : shell, { status: page.status, headers: page.headers })
  }

  const signOutPage = () => html(200, `<h1>board</h1>${SIGN_OUT_FORM}`)
  const pages: Record<string, (request: Request, url: URL) => Response | Promise<Response>> = {
    '/sign-in': (_request, url) => signIn(url),
    '/sign-in/callback': callback,
    '/sign-out': signOutPage,
    '/app.js': inspect,
  }

  return async (request) => {
    const url = new URL(request.url)
    const reading = request.method === 'GET' || request.method === 'HEAD'
    if (url.pathname === '/board' || url.pathname.startsWith('/board/')) return proxy(request, url)
    if (url.pathname === '/sign-out' && request.method === 'POST') return signOut(request)
    if (!reading) return json(405, 'method_not_allowed', 'method not allowed')
    return (Object.hasOwn(pages, url.pathname) ? pages[url.pathname]! : home)(request, url)
  }
}
