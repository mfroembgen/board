#!/usr/bin/env node
// Prints an AuthKit access token for the board, for vb's BOARD_TOKEN. Signs in through the browser
// (S256 PKCE on a loopback port) the first time or with --login, then refreshes. Keeps the client,
// refresh token and current access token in ~/.config/board-token/, one file per issuer and board, readable
// only by you. Parallel runs share one refresh: the first takes a lock, the others wait and reuse its token.
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const BOARD = env('BOARD_URL')
const ISSUER = env('AUTHKIT_ISSUER')
const scope = `${ISSUER}\n${BOARD}`
const digest = createHash('sha256').update(scope).digest('hex')
const key = digest.slice(0, 16)
const file = join(homedir(), '.config', 'board-token', `${new URL(BOARD).host}-${key}.json`)
const lock = `${file}.lock`

type Saved = {
  clientId: string
  redirectUri: string
  refreshToken?: string
  accessToken?: string
  expiresAt?: number
}
type Tokens = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')

async function load(): Promise<Saved | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Saved
  } catch {
    return null
  }
}

/** Replaces the file in one step, so a parallel run never reads half of it. */
async function save(saved: Saved) {
  const temporary = `${file}.${process.pid}`
  await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 })
  await rename(temporary, file)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid recorded in the lock, or 0 while there is none. */
function owner(): number {
  try {
    return Number(readFileSync(join(lock, 'pid'), 'utf8')) || 0
  } catch {
    return 0
  }
}

/**
 * Holds the lock while `work` runs, and releases it however this process ends. Taking it and recording
 * this pid happen in one synchronous step, so no signal lands between them. Nothing removes another run's
 * lock: one whose recorded owner has ended stops this run with what to remove, as does waiting longer
 * than a sign-in can take.
 */
async function locked<T>(work: () => Promise<T>): Promise<T> {
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  let held = false
  const release = () => {
    if (held) rmSync(lock, { recursive: true, force: true })
    held = false
  }
  process.once('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => process.exit(130))
  const stuck = (why: string) => new Error(`${lock} ${why}: if no other board-token is running, remove it and retry`)
  for (const started = Date.now(); !held; ) {
    try {
      mkdirSync(lock)
      held = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = owner()
      // Read it again: an owner that released the lock and exited leaves no pid, or a new owner's.
      if (pid > 0 && !alive(pid) && owner() === pid) throw stuck(`is left from a run that ended (pid ${pid})`)
      if (Date.now() - started > 360_000) throw stuck('has been held for 6 minutes')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  try {
    // Still the same synchronous step as taking the lock; a failed write releases it like any failure.
    writeFileSync(join(lock, 'pid'), String(process.pid))
    return await work()
  } finally {
    release()
    process.removeListener('exit', release)
  }
}

const fresh = (saved: Saved | null): saved is Saved & { accessToken: string } =>
  !!saved?.accessToken && (saved.expiresAt ?? 0) > Date.now() + 60_000

async function token(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(`${ISSUER}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ ...body, resource: BOARD }) })
  const tokens = (await response.json()) as Tokens
  if (!response.ok) throw new Error(`AuthKit: ${tokens.error_description ?? tokens.error ?? response.status}`)
  return tokens
}

/** The browser sign-in: registers this machine's public client once, then Authorization Code with PKCE. */
async function login(saved: Saved | null): Promise<Saved> {
  const server = createServer()
  const listening = (port: number) =>
    new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve()))
  try {
    await listening(saved ? Number(new URL(saved.redirectUri).port) : 0)
  } catch (error) {
    // The port this machine's client was registered with is taken: register a new client on a free one.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !saved) throw error
    return login(null)
  }
  const port = (server.address() as { port: number }).port
  const redirectUri = saved?.redirectUri ?? `http://127.0.0.1:${port}/callback`
  let clientId = saved?.clientId
  if (!clientId) {
    const response = await fetch(`${ISSUER}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'board CLI',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    if (!response.ok) throw new Error(`AuthKit registration answered ${response.status}: ${await response.text()}`)
    clientId = ((await response.json()) as { client_id: string }).client_id
  }

  const verifier = base64url(randomBytes(32))
  const state = base64url(randomBytes(16))
  const authorize = new URL(`${ISSUER}/oauth2/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid email offline_access',
    state,
    resource: BOARD,
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString()
  console.error(`Sign in to the board in your browser:\n  ${authorize}`)
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [authorize.toString()], () => {})

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sign-in timed out after 5 minutes')), 300_000)
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri)
      if (url.pathname !== '/callback') return void response.writeHead(404).end()
      const ok = url.searchParams.get('state') === state && url.searchParams.get('iss') === ISSUER && url.searchParams.has('code')
      const page = ok ? 'Signed in to the board. You can close this tab.' : 'Sign-in failed.'
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain', connection: 'close' }).end(page)
      clearTimeout(timer)
      ok ? resolve(url.searchParams.get('code')!) : reject(new Error(url.searchParams.get('error_description') ?? 'sign-in failed'))
    })
  }).finally(() => server.close())

  const tokens = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })
  return { clientId, redirectUri, ...kept(tokens) }
}

/** What a token response changes. A refresh that rotates nothing keeps the refresh token it used. */
const kept = (tokens: Tokens, refreshToken?: string) => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token ?? refreshToken,
  expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000,
})

const forced = process.argv.includes('--login')
let saved = await load()
if (forced || !fresh(saved)) {
  saved = await locked(async () => {
    const current = await load()
    if (!forced && fresh(current)) return current
    let next: Saved
    if (forced || !current?.refreshToken) next = await login(current)
    else {
      try {
        const tokens = await token({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId })
        next = { ...current, ...kept(tokens, current.refreshToken) }
      } catch (error) {
        console.error(`${(error as Error).message}; signing in again`)
        next = await login(current)
      }
    }
    await save(next)
    return next
  })
}
process.stdout.write(saved!.accessToken!)
