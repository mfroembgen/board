import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import { syncFromEnv, type SyncOptions } from '../src/sync.ts'
import { asAda, board, channel, eventually, inbox, thread, until, URL_, type App } from './sync-board.ts'

const GITLAB_API = 'https://gitlab.test/api/v4'
const SECRET = 'gitlab-webhook-secret'
const MR_URL = 'https://gitlab.test/acme/platform/web/-/merge_requests'

const projectOf = (id: number, path: string) => ({ id, name: path.split('/').pop(), path_with_namespace: path, web_url: `https://gitlab.test/${path}` })
const person = (username: string) => ({ id: username.length, name: username, username, avatar_url: null })

function mergeRequestItem(iid: number, extra: Record<string, unknown> = {}) {
  return {
    iid,
    title: 'Ship the export page',
    state: 'opened',
    draft: false,
    sha: 'a1b2c3d4e5f6a7b8',
    head_pipeline: { id: 300, status: 'failed' },
    web_url: `${MR_URL}/${iid}`,
    references: { full: `acme/platform/web!${iid}` },
    author: { id: 6, username: 'bo', name: 'Bo' },
    ...extra,
  }
}

const issueItem = (extra: Record<string, unknown> = {}) => ({
  iid: 3,
  title: 'Export page is blank',
  state: 'opened',
  web_url: 'https://gitlab.test/acme/platform/web/-/issues/3',
  references: { full: 'acme/platform/web#3' },
  author: { id: 5, username: 'ada', name: 'Ada' },
  ...extra,
})

let api: Record<string, unknown> = {}
const posted: string[] = []
beforeEach(() => {
  api = {
    '/user': { id: 99, username: 'board', name: 'Board' },
    '/projects/42': projectOf(42, 'acme/platform/web'),
    '/projects/50': projectOf(50, 'acme/hiring/pipeline'),
    '/projects/77': projectOf(77, 'acme/forks/web'),
    '/projects/42/merge_requests/7': mergeRequestItem(7),
    '/projects/42/merge_requests/8': mergeRequestItem(8),
    '/projects/42/issues/3': issueItem(),
  }
  posted.length = 0
})
const setItem = (path: string, extra: Record<string, unknown>) => void (api[path] = { ...(api[path] as object), ...extra })

mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(GITLAB_API)) return new Response('not found', { status: 404 })
  const path = new URL(url).pathname.slice(new URL(GITLAB_API).pathname.length)
  if ((init?.method ?? 'GET') !== 'GET') {
    posted.push(path)
    return Response.json({ id: 5000 + posted.length, body: '', author: { id: 99, username: 'board', name: 'Board' }, created_at: '2026-11-27T11:00:00Z', updated_at: '2026-11-27T11:00:00Z', system: false, type: null }, { status: 201 })
  }
  return api[path] ? Response.json(api[path]) : new Response('not found', { status: 404 })
})

const gitlabSync = (excludedPaths: string[] = []): SyncOptions['gitlab'] => ({ token: 'glpat-test', webhookSecret: SECRET, apiUrl: GITLAB_API, excludedPaths })

const gitlabHook = (app: App, event: string, body: unknown, token = SECRET) =>
  app(new Request(`${URL_}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitlab-event': event, 'x-gitlab-token': token, 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  }))

function note(id: number, discussion: string, text: string, options: { path?: string; projectId?: number; iid?: number; email?: string } = {}) {
  const path = options.path ?? 'acme/platform/web'
  const projectId = options.projectId ?? 42
  return {
    object_kind: 'note',
    event_type: 'note',
    user: { id: 5, name: 'Ada', username: 'ada', avatar_url: null, email: options.email ?? '[REDACTED]' },
    project_id: projectId,
    project: projectOf(projectId, path),
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
    merge_request: { id: 900, iid: options.iid ?? 7, title: 'Ship the export page' },
  }
}

function mergeRequest(action: string, extra: { by?: string; iid?: number; oldrev?: string; changes?: object; path?: string; source?: string } = {}) {
  const iid = extra.iid ?? 7
  const path = extra.path ?? 'acme/platform/web'
  return {
    object_kind: 'merge_request',
    user: person(extra.by ?? 'bo'),
    project: projectOf(42, path),
    object_attributes: {
      iid,
      title: 'Ship the export page',
      url: `${MR_URL}/${iid}`,
      action,
      last_commit: { id: 'a1b2c3d4e5f6a7b8' },
      source: { path_with_namespace: extra.source ?? path },
      target: { path_with_namespace: path },
      ...(extra.oldrev ? { oldrev: extra.oldrev } : {}),
    },
    changes: extra.changes ?? {},
  }
}

function issue(action: string, by = 'ada') {
  return {
    object_kind: 'issue',
    user: person(by),
    project: projectOf(42, 'acme/platform/web'),
    object_attributes: { iid: 3, title: 'Export page is blank', url: 'https://gitlab.test/acme/platform/web/-/issues/3', action },
    changes: {},
  }
}

function pipeline(id: number, status: string, options: { project?: { id: number; path: string }; target?: number; variables?: object[] } = {}) {
  const project = options.project ?? { id: 42, path: 'acme/platform/web' }
  return {
    object_kind: 'pipeline',
    user: person('bo'),
    project: projectOf(project.id, project.path),
    object_attributes: { id, status, sha: 'a1b2c3d4e5f6a7b8', url: `https://gitlab.test/${project.path}/-/pipelines/${id}`, variables: options.variables ?? [] },
    merge_request: { iid: 7, url: `${MR_URL}/7`, source_project_id: project.id, target_project_id: options.target ?? project.id },
  }
}

const mergeRequestRoot = (app: App, iid = 7) =>
  eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null && message.labels.mr === `acme/platform/web!${iid}`))
const mirrored = ({ status: _triage, ...labels }: Record<string, string>) => labels
const repliesOf = (found: { replies: { text: string }[] }) => found.replies.map((reply) => reply.text)

test('each sync entry is on only when its variables are given', async () => {
  const entries = async (env: Record<string, string>) => {
    const discovery = (await (await board(syncFromEnv(env))(new Request(URL_))).json()) as { sync: { key: string }[] }
    return discovery.sync.map((entry) => entry.key).sort()
  }
  const credentials = JSON.stringify({ client_email: 'board@chat.iam.gserviceaccount.com', private_key: 'unused' })

  assert.deepEqual(await entries({}), [])
  assert.deepEqual(await entries({ GITLAB_API_URL: GITLAB_API, GOOGLE_CHAT_PROJECT_NUMBER: '1' }), [])
  assert.deepEqual(await entries({ GITLAB_TOKEN: 't', GITLAB_WEBHOOK_SECRET: 's', GITLAB_API_URL: GITLAB_API }), ['gitlab'])
  assert.deepEqual(await entries({ GOOGLE_CHAT_CREDENTIALS: credentials, GOOGLE_CHAT_PROJECT_NUMBER: '1' }), ['gchat'])
  assert.throws(() => syncFromEnv({ GITLAB_TOKEN: 't' }), /GitLab sync needs GITLAB_WEBHOOK_SECRET, GITLAB_API_URL/)
})

test('a GitLab comment with the webhook secret lands in its subgroup channel, one thread per merge request', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))).status, 200)
  assert.equal((await gitlabHook(app, 'Note Hook', note(1002, 'd2', 'one more thing'))).status, 200)

  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  assert.deepEqual(mirrored(root.labels), { mr: 'acme/platform/web!7', state: 'open', head: 'a1b2c3d4e5f6a7b8' })
  const found = await until(app, root.id, ({ replies }) => replies.length === 2)
  assert.deepEqual(repliesOf(found).sort(), ['looks good', 'one more thing'])
})

test('a GitLab webhook without the secret is refused and stores nothing', async () => {
  const app = board({ gitlab: gitlabSync() })
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'), 'wrong')).status, 401)
  assert.deepEqual(await inbox(app, 'gitlab'), [])
})

test('the inbox keeps no pipeline variables or other payload fields the sync does not use', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good', { email: 'ada-sekrit@example.com' }))
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed', { variables: [{ key: 'DEPLOY_TOKEN', value: 'glpat-sekrit' }] }))
  const stored = await eventually(async () => {
    const events = await inbox(app, 'gitlab')
    return events.length === 2 ? events : undefined
  })
  assert.doesNotMatch(JSON.stringify(stored), /sekrit|DEPLOY_TOKEN/)
})

test('an excluded namespace is answered and never stored, wherever the payload names it', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  const hiring = { id: 50, path: 'acme/hiring/pipeline' }
  const sent = [
    await gitlabHook(app, 'Note Hook', note(2001, 'd9', 'candidate notes', { path: hiring.path, projectId: 50 })),
    await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { path: hiring.path })),
    await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { source: hiring.path })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(301, 'failed', { project: hiring })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(302, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 50 })),
    await gitlabHook(app, 'Pipeline Hook', pipeline(303, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 404 })),
  ]
  assert.deepEqual(sent.map((response) => response.status), [200, 200, 200, 200, 200, 200])
  assert.equal((await gitlabHook(app, 'Note Hook', note(2002, 'd9', 'candidate notes', { path: hiring.path, projectId: 50 }), 'wrong')).status, 401)
  assert.equal((await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))).status, 200)
  await mergeRequestRoot(app)
  assert.equal((await inbox(app, 'gitlab')).length, 1)
})

test('a board thread synced to an excluded merge request never posts there', async () => {
  const app = board({ gitlab: gitlabSync(['acme/hiring']) })
  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const synced = await mergeRequestRoot(app)
  const own = ((await (await asAda(app, 'POST', '/messages', { channel: 'general', text: 'candidate review' })).json()) as { message: { id: string } }).message
  assert.equal((await asAda(app, 'POST', `/messages/${own.id}/sync`, { target: 'gitlab:50:mr:2' })).status, 200)

  await asAda(app, 'POST', '/messages', { re: own.id, text: 'notes on the candidate' })
  await asAda(app, 'POST', '/messages', { re: synced.id, text: 'thanks' })
  await eventually(async () => (posted.some((path) => path.startsWith('/projects/42/')) ? true : undefined))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(posted.filter((path) => path.startsWith('/projects/50/')), [])
})

test('a new thread from GitLab is labelled for triage and announced', async () => {
  const app = board({ gitlab: gitlabSync(), triageChannel: 'triage' })
  const own = ((await (await asAda(app, 'POST', '/messages', { channel: 'gitlab/notes', text: 'written on the board' })).json()) as { message: { id: string } }).message

  await gitlabHook(app, 'Note Hook', note(1001, 'd1', 'looks good'))
  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.re === null && message.labels.status))
  assert.equal(root.labels.status, 'triage')
  const announced = await eventually(async () => (await channel(app, 'triage'))[0])
  assert.equal(announced.text, `gitlab/platform #${root.id}: MR !7: Ship the export page`)
  assert.equal((await channel(app, 'gitlab/notes')).find((message) => message.id === own.id)?.labels.status, undefined)
})

test("a merge request's life is one thread: its state, title, approvals and merge, as GitLab has them now", async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/7'
  setItem(mr, { draft: true })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  assert.deepEqual(mirrored(root.labels), { mr: 'acme/platform/web!7', state: 'draft', head: 'a1b2c3d4e5f6a7b8' })

  setItem(mr, { draft: false })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { changes: { draft: { previous: true, current: false } } }))
  await until(app, root.id, ({ message }) => message.labels.state === 'open')
  setItem(mr, { title: 'Ship the export page today' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { changes: { title: { previous: 'Ship the export page', current: 'Ship the export page today' } } }))
  await until(app, root.id, ({ message }) => message.text.startsWith('MR !7: Ship the export page today'))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approval', { by: 'ada' }))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approved', { by: 'bo' }))
  await until(app, root.id, ({ message }) => message.labels.review === 'approved')
  setItem(mr, { state: 'merged' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('merge', { by: 'julian' }))
  const merged = await until(app, root.id, ({ message }) => message.labels.state === 'merged')
  assert.deepEqual(repliesOf(merged), ['approved by ada', 'approved by bo', 'merged by julian'])
  assert.ok(merged.replies.every((reply) => reply.labels.status === undefined))
})

test('a close that arrives after the reopen still says so, and leaves the state GitLab has', async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/8'
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open', { iid: 8 }))
  const root = await mergeRequestRoot(app, 8)
  setItem(mr, { state: 'closed' })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('close', { iid: 8, by: 'ada' }))
  await until(app, root.id, ({ message }) => message.labels.state === 'closed')
  setItem(mr, { state: 'opened', draft: true })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('reopen', { iid: 8, by: 'ada' }))
  await until(app, root.id, ({ message }) => message.labels.state === 'draft')
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('close', { iid: 8, by: 'bo' }))
  const late = await until(app, root.id, ({ replies }) => replies.length === 3)
  assert.deepEqual(repliesOf(late), ['closed by ada', 'reopened by ada', 'closed by bo'])
  assert.equal(late.message.labels.state, 'draft')
})

test('a failure of the head pipeline labels and replies; a superseded run, or one GitLab has since passed, stays off', async () => {
  const app = board({ gitlab: gitlabSync() })
  const mr = '/projects/42/merge_requests/7'
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  await gitlabHook(app, 'Pipeline Hook', pipeline(299, 'canceled'))
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  const failed = await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  assert.deepEqual(repliesOf(failed), [`pipeline failed on acme/platform/web!7 at a1b2c3d4: https://gitlab.test/acme/platform/web/-/pipelines/300`])

  setItem(mr, { head_pipeline: { id: 300, status: 'success' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'success'))
  await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === undefined)
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('approval', { by: 'ada' }))
  const after = await until(app, root.id, ({ replies }) => replies.length === 2)
  assert.deepEqual(repliesOf(after).slice(1), ['approved by ada'])
  assert.equal(after.message.labels['ci.42-7.pipeline'], undefined)
})

test("a fork's pipeline lands on the target project's merge request", async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/merge_requests/7', { head_pipeline: { id: 400, status: 'failed' } })
  await gitlabHook(app, 'Pipeline Hook', pipeline(400, 'failed', { project: { id: 77, path: 'acme/forks/web' }, target: 42 }))
  const root = await mergeRequestRoot(app)
  const failed = await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  assert.match(repliesOf(failed)[0]!, /^pipeline failed on acme\/platform\/web!7 at a1b2c3d4: https:\/\/gitlab\.test\/acme\/forks\/web\/-\/pipelines\/400$/)
})

test('a new commit on a merge request moves its head and clears its pipeline labels', async () => {
  const app = board({ gitlab: gitlabSync() })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('open'))
  const root = await mergeRequestRoot(app)
  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  await until(app, root.id, ({ message }) => message.labels['ci.42-7.pipeline'] === 'failed')
  setItem('/projects/42/merge_requests/7', { sha: 'b2c3d4e5f6a7b8c9', head_pipeline: { id: 301, status: 'running' } })
  await gitlabHook(app, 'Merge Request Hook', mergeRequest('update', { oldrev: 'a1b2c3d4e5f6a7b8' }))
  const pushed = await until(app, root.id, ({ message }) => message.labels.head === 'b2c3d4e5f6a7b8c9')
  assert.equal(pushed.message.labels['ci.42-7.pipeline'], undefined)
  assert.equal(pushed.replies.length, 1)
})

test("an issue's opening, closing and reopening land in its thread", async () => {
  const app = board({ gitlab: gitlabSync() })
  const item = '/projects/42/issues/3'
  await gitlabHook(app, 'Issue Hook', issue('open'))
  const root = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.labels.issue === 'acme/platform/web#3'))
  assert.equal(root.text, 'Issue #3: Export page is blank\nhttps://gitlab.test/acme/platform/web/-/issues/3')
  assert.equal(root.labels.state, 'open')
  setItem(item, { state: 'closed' })
  await gitlabHook(app, 'Issue Hook', issue('close', 'bo'))
  await until(app, root.id, ({ message }) => message.labels.state === 'closed')
  setItem(item, { state: 'opened' })
  await gitlabHook(app, 'Issue Hook', issue('reopen', 'bo'))
  const reopened = await until(app, root.id, ({ message, replies }) => message.labels.state === 'open' && replies.length === 2)
  assert.deepEqual(repliesOf(reopened), ['closed by bo', 'reopened by bo'])
})

test('an issue or merge request from before the sync gets its root from GitLab when its first event comes', async () => {
  const app = board({ gitlab: gitlabSync() })
  setItem('/projects/42/issues/3', { state: 'closed' })
  await gitlabHook(app, 'Issue Hook', issue('close', 'bo'))
  const closed = await eventually(async () => (await channel(app, 'gitlab/platform')).find((message) => message.labels.issue === 'acme/platform/web#3'))
  assert.equal(closed.text, 'Issue #3: Export page is blank\nhttps://gitlab.test/acme/platform/web/-/issues/3')
  assert.equal(closed.labels.state, 'closed')
  assert.deepEqual(repliesOf(await until(app, closed.id, ({ replies }) => replies.length === 1)), ['closed by bo'])

  await gitlabHook(app, 'Pipeline Hook', pipeline(300, 'failed'))
  const root = await mergeRequestRoot(app)
  assert.equal(root.text, `MR !7: Ship the export page\n${MR_URL}/7`)
  const failed = await until(app, root.id, ({ replies }) => replies.length === 1)
  assert.equal(failed.message.labels['ci.42-7.pipeline'], 'failed')
  assert.equal((await thread(app, root.id)).message.labels.state, 'open')
})
