import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, importPKCS8, SignJWT } from 'jose'
import { createApp } from '../src/app.ts'
import { syncFromEnv, type SyncOptions } from '../src/sync.ts'

const URL_ = 'https://board.test/api/board'
const AUTHKIT = 'https://tenant.authkit.test'
const GITLAB_API = 'https://gitlab.test/api/v4'
const SECRET = 'gitlab-webhook-secret'
const PROJECT_NUMBER = '123456789'
const ADD_ON = `service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
const GCHAT_ENDPOINT = `${URL_}/webhooks/gchat`

const people = await generateKeyPair('RS256')
const peopleJwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(people.publicKey)), kid: 'k', alg: 'RS256' }] })
const ada = await new SignJWT({ sub: 'user_ada' })
  .setProtectedHeader({ alg: 'RS256', kid: 'k' })
  .setIssuer(AUTHKIT)
  .setAudience(URL_)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(people.privateKey)

const keys = mkdtempSync(join(tmpdir(), 'board-sync-'))
after(() => rmSync(keys, { recursive: true, force: true }))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=google-test', '-keyout', join(keys, 'key.pem'), '-out', join(keys, 'cert.pem')], { stdio: 'ignore' })
const googlePrivateKey = readFileSync(join(keys, 'key.pem'), 'utf8')
const googleCert = readFileSync(join(keys, 'cert.pem'), 'utf8')
const googleKey = await importPKCS8(googlePrivateKey, 'RS256')

const gitlabApi: Record<string, unknown> = {
  '/user': { id: 99, username: 'board', name: 'Board' },
  '/projects/42': { id: 42, name: 'web', path_with_namespace: 'acme/platform/web', web_url: 'https://gitlab.test/acme/platform/web' },
  '/projects/42/merge_requests/7': {
    id: 900,
    iid: 7,
    project_id: 42,
    title: 'Ship the export page',
    description: null,
    state: 'opened',
    web_url: 'https://gitlab.test/acme/platform/web/-/merge_requests/7',
    references: { full: 'acme/platform/web!7' },
    author: { id: 6, username: 'bo', name: 'Bo' },
    created_at: '2026-11-27T09:00:00Z',
    updated_at: '2026-11-27T09:00:00Z',
  },
}

mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input)
  const found = url.startsWith(GITLAB_API) ? gitlabApi[url.slice(GITLAB_API.length)] : undefined
  return found ? Response.json(found) : new Response('not found', { status: 404 })
})

Object.assign(globalThis, {
  window: {
    fetch: async (input: RequestInfo | URL) =>
      String(input) === 'https://www.googleapis.com/oauth2/v1/certs' ? Response.json({ google: googleCert }) : new Response('not found', { status: 404 }),
  },
})

const gitlabSync = (excludedPaths: string[] = []): SyncOptions['gitlab'] => ({ token: 'glpat-test', webhookSecret: SECRET, apiUrl: GITLAB_API, excludedPaths })
const gchatSync: SyncOptions['gchat'] = {
  credentials: { client_email: 'board@chat.iam.gserviceaccount.com', private_key: googlePrivateKey },
  projectNumber: PROJECT_NUMBER,
  botUserId: 'users/1',
  channelsBySpace: { 'spaces/AAAA': 'support' },
}

function board(sync: SyncOptions) {
  return createApp({
    url: URL_,
    dir: { memory: true },
    people: {
      issuer: AUTHKIT,
      domain: 'example.com',
      jwks: peopleJwks,
      fetch: async () => Response.json({ sub: 'user_ada', email: 'ada@example.com', email_verified: true }),
    },
    sync,
  })
}

type App = ReturnType<typeof board>
type Message = { id: string; re: string | null; channel: string; text: string; labels: Record<string, string> }

const read = async <T>(app: App, path: string): Promise<T> => {
  const response = await app(new Request(`${URL_}${path}`, { headers: { authorization: `Bearer ${ada}` } }))
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()) as T
}
const channel = async (app: App, path: string) => (await read<{ messages: Message[] }>(app, `/messages?channel=${encodeURIComponent(path)}`)).messages
const inbox = async (app: App, key: string) => (await read<{ events: unknown[] }>(app, `/inbox/${key}`)).events

async function eventually<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const found = await check()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function note(id: number, discussion: string, text: string, path = 'acme/platform/web') {
  return {
    object_kind: 'note',
    event_type: 'note',
    user: { id: 5, name: 'Ada', username: 'ada', avatar_url: null },
    project_id: 42,
    project: { id: 42, name: 'web', path_with_namespace: path, web_url: `https://gitlab.test/${path}` },
    object_attributes: {
      id,
      note: text,
      noteable_type: 'MergeRequest',
      author_id: 5,
      created_at: '2026-11-27T10:00:00Z',
      updated_at: '2026-11-27T10:00:00Z',
      system: false,
      type: null,
      action: 'create',
      internal: false,
      discussion_id: discussion,
    },
    merge_request: { id: 900, iid: 7, title: 'Ship the export page' },
  }
}

const gitlabHook = (app: App, body: unknown, token = SECRET) =>
  app(new Request(`${URL_}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitlab-event': 'Note Hook', 'x-gitlab-token': token },
    body: JSON.stringify(body),
  }))

const googleToken = (claims: Record<string, unknown>) =>
  new SignJWT({ email: ADD_ON, email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'google' })
    .setIssuer('https://accounts.google.com')
    .setAudience(GCHAT_ENDPOINT)
    .setSubject('1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(googleKey)

const chatMessage = {
  commonEventObject: { hostApp: 'CHAT' },
  chat: {
    eventTime: '2026-11-27T10:00:00Z',
    messagePayload: {
      space: { name: 'spaces/AAAA', type: 'ROOM', displayName: 'Support' },
      message: {
        name: 'spaces/AAAA/messages/m1.m1',
        sender: { name: 'users/7', displayName: 'Ada', type: 'HUMAN' },
        text: 'the export page is blank',
        thread: { name: 'spaces/AAAA/threads/t1' },
        space: { name: 'spaces/AAAA' },
        createTime: '2026-11-27T10:00:00Z',
      },
    },
  },
}

const gchatHook = (app: App, authorization?: string) =>
  app(new Request(GCHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(chatMessage),
  }))

test('each sync entry is on only when its variables are given', async () => {
  const entries = async (env: Record<string, string>) => {
    const discovery = (await (await board(syncFromEnv(env))(new Request(URL_))).json()) as { sync: { key: string }[] }
    return discovery.sync.map((entry) => entry.key).sort()
  }

  assert.deepEqual(await entries({}), [])
  assert.deepEqual(await entries({ GITLAB_API_URL: GITLAB_API, GOOGLE_CHAT_PROJECT_NUMBER: PROJECT_NUMBER }), [])
  assert.deepEqual(await entries({ GITLAB_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 's', GITLAB_API_URL: GITLAB_API }), ['gitlab'])
  assert.deepEqual(
    await entries({ GOOGLE_CHAT_CREDENTIALS: JSON.stringify(gchatSync!.credentials), GOOGLE_CHAT_PROJECT_NUMBER: PROJECT_NUMBER }),
    ['gchat'],
  )
  assert.throws(() => syncFromEnv({ GITLAB_TOKEN: 't' }), /GitLab sync needs GITLAB_WEBHOOK_SECRET, GITLAB_API_URL/)
})

test('a GitLab comment with the webhook secret lands in its subgroup channel, one thread per merge request', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, note(1001, 'd1', 'looks good'))).status, 200)
  assert.equal((await gitlabHook(app, note(1002, 'd2', 'one more thing'))).status, 200)

  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null))
  assert.match(root.text, /Ship the export page/)
  assert.equal(root.labels.ref, 'acme/platform/web!7')
  const thread = await eventually(async () => {
    const found = await read<{ replies: Message[] }>(app, `/messages/${root.id}`)
    return found.replies.length === 2 ? found : undefined
  })
  assert.deepEqual(thread.replies.map((reply) => reply.text).sort(), ['looks good', 'one more thing'])
})

test('a GitLab webhook without the secret is refused and stores nothing', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, note(1001, 'd1', 'looks good'), 'wrong')).status, 401)
  assert.deepEqual(await inbox(app, 'gitlab'), [])
})

test('an excluded GitLab namespace is answered and never stored', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  assert.equal((await gitlabHook(app, note(2001, 'd9', 'candidate notes', 'acme/hiring/pipeline'))).status, 200)
  assert.equal((await gitlabHook(app, note(2002, 'd9', 'candidate notes', 'acme/hiring/pipeline'), 'wrong')).status, 401)
  assert.equal((await gitlabHook(app, note(1001, 'd1', 'looks good'))).status, 200)
  await eventually(async () => ((await channel(app, 'gitlab/platform')).length ? true : undefined))
  assert.equal((await inbox(app, 'gitlab')).length, 1)
})

test('a new thread from GitLab is labelled for triage and announced', async () => {
  const app = board({ gitlab: gitlabSync(), triageChannel: 'triage' })
  const own = (await (await app(new Request(`${URL_}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ada}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'gitlab/notes', text: 'written on the board' }),
  }))).json()) as { message: Message }

  assert.equal((await gitlabHook(app, note(1001, 'd1', 'looks good'))).status, 200)
  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null && message.labels.status))
  assert.equal(root.labels.status, 'triage')
  const announced = await eventually(async () => (await channel(app, 'triage'))[0])
  assert.equal(announced.text, `gitlab/platform #${root.id}: **Ship the export page**`)
  assert.equal((await channel(app, 'gitlab/notes')).find((message) => message.id === own.message.id)?.labels.status, undefined)
})

test('a Google Chat message signed for the board by the Chat app lands in its space channel', async () => {
  const app = board({ gchat: gchatSync })
  assert.equal((await gchatHook(app, `Bearer ${await googleToken({})}`)).status, 200)
  const message = await eventually(async () => (await channel(app, 'support'))[0])
  assert.equal(message.text, 'the export page is blank')
})

test('a Google Chat webhook without a token, or with one from another add-on, is refused and stores nothing', async () => {
  const app = board({ gchat: gchatSync })
  assert.equal((await gchatHook(app)).status, 401)
  assert.equal((await gchatHook(app, `Bearer ${await googleToken({ email: 'service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com' })}`)).status, 401)
  assert.deepEqual(await inbox(app, 'gchat'), [])
})
