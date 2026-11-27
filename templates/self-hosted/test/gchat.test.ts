import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import { exportJWK, importPKCS8, SignJWT } from 'jose'
import type { SyncOptions } from '../src/sync.ts'
import { board, channel, eventually, inbox, URL_, type App } from './sync-board.ts'

const PROJECT_NUMBER = '123456789'
const ADD_ON = `service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
const ENDPOINT = `${URL_}/webhooks/gchat`
process.env.GOOGLE_CHAT_PROJECT_NUMBER = PROJECT_NUMBER
process.env.GOOGLE_CHAT_PUBSUB_AUDIENCE = ENDPOINT
process.env.GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL = ADD_ON

const keys = mkdtempSync(join(tmpdir(), 'board-gchat-'))
after(() => rmSync(keys, { recursive: true, force: true }))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=google-test', '-keyout', join(keys, 'key.pem'), '-out', join(keys, 'cert.pem')], { stdio: 'ignore' })
const privateKey = readFileSync(join(keys, 'key.pem'), 'utf8')
const cert = readFileSync(join(keys, 'cert.pem'), 'utf8')
const signingKey = await importPKCS8(privateKey, 'RS256')
const publicJwk = { ...(await exportJWK(createPublicKey(privateKey))), kid: 'google', alg: 'RS256', use: 'sig' }

const answers: Record<string, unknown> = {
  'https://www.googleapis.com/oauth2/v3/certs': { keys: [publicJwk] },
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com': { chat: cert },
  'https://www.googleapis.com/oauth2/v1/certs': { google: cert },
}
const answer = async (input: RequestInfo | URL) => {
  const found = answers[String(input instanceof Request ? input.url : input)]
  return found ? Response.json(found) : new Response('not found', { status: 404 })
}
mock.method(globalThis, 'fetch', answer)
Object.assign(globalThis, { window: { fetch: answer } })

const logged: string[] = []
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[method].bind(console)
  mock.method(console, method, (...args: unknown[]) => {
    logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {})))).join(' '))
    original(...args)
  })
}

const gchatSync: SyncOptions['gchat'] = {
  credentials: { client_email: 'board@chat.iam.gserviceaccount.com', private_key: privateKey },
  projectNumber: PROJECT_NUMBER,
  botUserId: 'users/1',
  channelsBySpace: { 'spaces/AAAA': 'support' },
}

const token = (claims: Record<string, unknown> = {}, options: { kid?: string; issuer?: string; audience?: string } = {}) =>
  new SignJWT({ email: ADD_ON, email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'google' })
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? ENDPOINT)
    .setSubject('1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey)

function chatEvent(options: { space?: Record<string, string>; extra?: object } = {}) {
  return {
    commonEventObject: { hostApp: 'CHAT' },
    chat: {
      eventTime: '2026-11-27T10:00:00Z',
      messagePayload: {
        space: options.space ?? { name: 'spaces/AAAA', type: 'ROOM', displayName: 'Support' },
        message: {
          name: 'spaces/AAAA/messages/m1.m1',
          sender: { name: 'users/7', displayName: 'Ada', type: 'HUMAN' },
          text: 'the export page is blank',
          thread: { name: 'spaces/AAAA/threads/t1' },
          space: { name: options.space?.name ?? 'spaces/AAAA' },
          createTime: '2026-11-27T10:00:00Z',
        },
      },
    },
    ...options.extra,
  }
}

const hook = (app: App, body: unknown, authorization?: string) =>
  app(new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  }))

test('a Google Chat message signed for the board by its own add-on lands in its space channel, without its credentials', async () => {
  const app = board({ gchat: gchatSync })
  const credentials = { authorizationEventObject: { userOAuthToken: 'ya29.sekrit-user', systemIdToken: 'eyJsekrit-system' } }
  assert.equal((await hook(app, chatEvent({ extra: credentials }), `Bearer ${await token()}`)).status, 200)
  const message = await eventually(async () => (await channel(app, 'support'))[0])
  assert.equal(message.text, 'the export page is blank')
  assert.doesNotMatch(JSON.stringify(await inbox(app, 'gchat')), /sekrit/)
})

test("tokens from another add-on, Chat's shared identity, or for the project number are refused and store nothing", async () => {
  const app = board({ gchat: gchatSync })
  const refused = [
    await hook(app, chatEvent()),
    await hook(app, chatEvent(), `Bearer ${await token({ email: 'service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com' })}`),
    await hook(app, chatEvent(), `Bearer ${await token({ email: 'chat@system.gserviceaccount.com' })}`),
    await hook(app, chatEvent(), `Bearer ${await token({ email: 'chat@system.gserviceaccount.com' }, { kid: 'chat', issuer: 'chat@system.gserviceaccount.com', audience: PROJECT_NUMBER })}`),
  ]
  assert.deepEqual(refused.map((response) => response.status), [401, 401, 401, 401])
  assert.deepEqual(await inbox(app, 'gchat'), [])
})

test('a refused token never reaches the logs', async () => {
  const app = board({ gchat: gchatSync })
  const presented = ['opaque-credential-0f3a9c', `${(await token()).slice(0, -8)}AAAAAAAA`]
  for (const credential of presented) assert.equal((await hook(app, chatEvent(), `Bearer ${credential}`)).status, 401)
  assert.ok(logged.some((line) => line.includes('gchat webhook refused')))
  for (const credential of presented) assert.ok(!logged.some((line) => line.includes(credential)), `logs hold ${credential.slice(0, 12)}…`)
})

test('a space the board maps to no channel stays off it and out of the inbox', async () => {
  const app = board({ gchat: gchatSync })
  const elsewhere = chatEvent({ space: { name: 'spaces/BBBB', type: 'ROOM', displayName: 'Elsewhere' } })
  assert.equal((await hook(app, elsewhere, `Bearer ${await token()}`)).status, 200)
  assert.deepEqual(await inbox(app, 'gchat'), [])
  assert.deepEqual(await channel(app, 'gchat/bbbb'), [])
})

test('a direct message to the app is answered and never stored, even from a space the board maps', async () => {
  const app = board({ gchat: { ...gchatSync!, channelsBySpace: { 'spaces/DDDD': 'support' } } })
  const dm = chatEvent({ space: { name: 'spaces/DDDD', type: 'DM', spaceType: 'DIRECT_MESSAGE' } })
  assert.equal((await hook(app, dm, `Bearer ${await token()}`)).status, 200)
  assert.deepEqual(await inbox(app, 'gchat'), [])
})

test('a Pub/Sub push is refused, whatever the environment says, since the board subscribes to no space', async () => {
  const app = board({ gchat: gchatSync })
  const push = { message: { data: Buffer.from(JSON.stringify({ message: { text: 'hi' } })).toString('base64'), attributes: {} }, subscription: 'projects/p/subscriptions/s' }
  assert.equal((await hook(app, push, `Bearer ${await token()}`)).status, 401)
  assert.deepEqual(await inbox(app, 'gchat'), [])
})
