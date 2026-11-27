import { createHash, timingSafeEqual } from 'node:crypto'
import { createGoogleChatAdapter } from '@chat-adapter/gchat'
import { createGitLabAdapter, type GitLabAdapter, type GitLabIssue, type GitLabMergeRequest } from '@chat-adapter/gitlab'
import type { Watcher } from '@vercel/board'
import type { SyncFn, SyncProvider, SyncRoot } from '@vercel/board/sync'
import { chatSdk, type ChatSdkEvent } from '@vercel/board/sync-chat-sdk'

export type GitLabSync = {
  token: string
  webhookSecret: string
  apiUrl: string
  botUserId?: number
  excludedPaths?: string[]
}

export type GoogleChatSync = {
  credentials: { client_email: string; private_key: string }
  projectNumber: string
  botUserId?: string
  channelsBySpace?: Record<string, string>
  pubsub?: { topic: string; serviceAccountEmail: string; impersonateUser: string }
}

export type SyncOptions = {
  gitlab?: GitLabSync
  gchat?: GoogleChatSync
  triageChannel?: string
}

type Env = Record<string, string | undefined>

function settings(env: Env, entry: string, switches: string[], names: string[]): Record<string, string> | undefined {
  if (!switches.some((name) => env[name])) return undefined
  const given = Object.fromEntries(names.flatMap((name) => (env[name] ? [[name, env[name]]] : [])))
  const missing = names.filter((name) => !given[name])
  if (missing.length) throw new Error(`${entry} sync needs ${missing.join(', ')} too`)
  return given
}

function list(value: string | undefined): string[] {
  const items = (value ?? '').split(',').map((item) => item.trim())
  return items.filter(Boolean)
}

function spaceMap(value: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(value).map((pair) => {
      const [space, channel] = pair.split('=').map((part) => part.trim())
      if (!space?.startsWith('spaces/') || !channel) throw new Error(`GOOGLE_CHAT_SPACES takes spaces/<id>=<channel> pairs, not ${pair}`)
      return [space, channel]
    }),
  )
}

function pubsubFrom(env: Env): GoogleChatSync['pubsub'] {
  const given = settings(env, 'Google Chat Pub/Sub', ['GOOGLE_CHAT_PUBSUB_TOPIC'], [
    'GOOGLE_CHAT_PUBSUB_TOPIC',
    'GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_CHAT_IMPERSONATE_USER',
  ])
  if (!given) return undefined
  return {
    topic: given.GOOGLE_CHAT_PUBSUB_TOPIC!,
    serviceAccountEmail: given.GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL!,
    impersonateUser: given.GOOGLE_CHAT_IMPERSONATE_USER!,
  }
}

export function syncFromEnv(env: Env): SyncOptions {
  const options: SyncOptions = {}
  const gitlab = settings(env, 'GitLab', ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'], ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET', 'GITLAB_API_URL'])
  if (gitlab) {
    options.gitlab = {
      token: gitlab.GITLAB_TOKEN!,
      webhookSecret: gitlab.GITLAB_WEBHOOK_SECRET!,
      apiUrl: gitlab.GITLAB_API_URL!,
      ...(env.GITLAB_BOT_USER_ID ? { botUserId: Number(env.GITLAB_BOT_USER_ID) } : {}),
      excludedPaths: list(env.GITLAB_EXCLUDE),
    }
  }
  const gchat = settings(env, 'Google Chat', ['GOOGLE_CHAT_CREDENTIALS'], ['GOOGLE_CHAT_CREDENTIALS', 'GOOGLE_CHAT_PROJECT_NUMBER'])
  if (gchat) {
    const pubsub = pubsubFrom(env)
    options.gchat = {
      credentials: JSON.parse(gchat.GOOGLE_CHAT_CREDENTIALS!),
      projectNumber: gchat.GOOGLE_CHAT_PROJECT_NUMBER!,
      ...(env.GOOGLE_CHAT_BOT_USER_ID ? { botUserId: env.GOOGLE_CHAT_BOT_USER_ID } : {}),
      channelsBySpace: spaceMap(env.GOOGLE_CHAT_SPACES),
      ...(pubsub ? { pubsub } : {}),
    }
  }
  if (env.BOARD_TRIAGE_CHANNEL) options.triageChannel = env.BOARD_TRIAGE_CHANNEL
  return options
}

export function segment(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '') || 'unnamed'
}

export function gitlabChannel(path: string): string {
  const parts = path.split('/')
  return `gitlab/${segment(parts.length > 2 ? parts[1]! : parts[0]!)}`
}

const native = (key: string, id: string) => id.slice(key.length + 1)
const noteable = (thread: string) => thread.split(':').slice(0, 3).join(':')

function sameSecret(expected: string, given: string | null): boolean {
  if (!given) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(given))
}

function excludedPath(body: string, excludedPaths: string[]): boolean {
  let path: unknown
  try {
    path = (JSON.parse(body) as { project?: { path_with_namespace?: unknown } }).project?.path_with_namespace
  } catch {
    return false
  }
  return typeof path === 'string' && excludedPaths.some((prefix) => path === prefix || (path as string).startsWith(`${prefix}/`))
}

function gitlab(options: GitLabSync): SyncProvider {
  const adapter: GitLabAdapter = createGitLabAdapter({
    token: options.token,
    webhookSecret: options.webhookSecret,
    apiUrl: options.apiUrl,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
  })
  const paths = new Map<string, Promise<string>>()
  const pathOf = (project: string) => {
    let path = paths.get(project)
    if (!path) {
      path = adapter.fetchChannelInfo(`gitlab:${project}`).then((info) => info.name ?? Promise.reject(new Error(`GitLab project ${project} has no path`)))
      path.catch(() => paths.delete(project))
      paths.set(project, path)
    }
    return path
  }

  const sync: SyncFn<ChatSdkEvent<'gitlab'>> = async (sync) => {
    if (sync.direction === 'out') return sync.target === null ? undefined : sync.deliver()
    if (sync.event.kind !== 'message') return void (await sync.import())
    const project = native(sync.key, sync.event.thread).split(':')[0]!
    await sync.import(gitlabChannel(await pathOf(project)))
  }

  const provider = chatSdk(
    {
      adapter,
      platform: 'gitlab',
      groupThread: noteable,
      fetchRoot: async (thread): Promise<Omit<SyncRoot, 'raw'>> => {
        const [project, kind, iid] = thread.split(':')
        const item = await adapter.request<GitLabMergeRequest | GitLabIssue>('GET', `/projects/${project}/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`)
        return {
          text: `**${item.title}**\n\n${item.web_url}`,
          labels: { gitlab: kind === 'mr' ? 'merge-request' : 'issue', ...(item.references?.full ? { ref: item.references.full } : {}) },
          author: {
            id: `gitlab:user:${item.author.id}`,
            handle: item.author.username,
            name: item.author.name || item.author.username,
            avatar: item.author.avatar_url ?? null,
            isBot: item.author.bot === true,
          },
        }
      },
    },
    sync,
  )

  const excludedPaths = options.excludedPaths ?? []
  if (excludedPaths.length === 0) return provider
  const receive = provider.receive.bind(provider)
  provider.receive = async (key, request, emit) => {
    const body = await request.clone().text()
    if (excludedPath(body, excludedPaths) && sameSecret(options.webhookSecret, request.headers.get('x-gitlab-token'))) return new Response('ok')
    return receive(key, request, emit)
  }
  return provider
}

function gchat(options: GoogleChatSync, endpointUrl: string): SyncProvider {
  const adapter = createGoogleChatAdapter({
    credentials: options.credentials,
    endpointUrl,
    workspaceAddOnServiceAccountEmail: `service-${options.projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
    ...(options.pubsub
      ? {
          pubsubTopic: options.pubsub.topic,
          pubsubAudience: endpointUrl,
          pubsubServiceAccountEmail: options.pubsub.serviceAccountEmail,
          impersonateUser: options.pubsub.impersonateUser,
        }
      : {}),
  })
  const channelsBySpace = options.channelsBySpace ?? {}

  const sync: SyncFn<ChatSdkEvent<'gchat'>> = async (sync) => {
    if (sync.direction === 'out') return sync.target === null ? undefined : sync.deliver()
    if (sync.event.thread.endsWith(':dm')) return
    const space = native(sync.key, sync.event.channel)
    await sync.import(channelsBySpace[space] ?? `gchat/${segment(space.replace(/^spaces\//, ''))}`)
  }

  return chatSdk({ adapter, platform: 'gchat' }, sync)
}

export function syncEntries(options: SyncOptions, boardUrl: string): Record<string, SyncProvider> {
  return {
    ...(options.gitlab ? { gitlab: gitlab(options.gitlab) } : {}),
    ...(options.gchat ? { gchat: gchat(options.gchat, `${boardUrl.replace(/\/+$/, '')}/webhooks/gchat`) } : {}),
  }
}
export function triage(channel?: string): Watcher {
  return {
    tail: 'gitlab/ --source gitlab',
    run: async ({ event, board }) => {
      const message = event.message
      if (event.type !== 'message.posted' || !message || message.re !== null) return
      await board.label(message.id, { set: { status: 'triage' } })
      if (channel) await board.post(channel, `${message.channel} #${message.id}: ${message.text.split('\n')[0]}`)
    },
  }
}
