import { createGoogleChatAdapter } from '@chat-adapter/gchat'
import type { Watcher } from '@vercel/board'
import type { SyncFn, SyncProvider } from '@vercel/board/sync'
import { chatSdk, type ChatSdkEvent } from '@vercel/board/sync-chat-sdk'
import { segment } from './channels.ts'
import { gitlab, type GitLabSync } from './gitlab.ts'

export type { GitLabSync }

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
    const space = sync.event.channel.slice(sync.key.length + 1)
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
