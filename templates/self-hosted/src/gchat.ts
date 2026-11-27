import { createGoogleChatAdapter } from '@chat-adapter/gchat'
import type { Receive, SyncProvider } from '@vercel/board/sync'
import { channels, chatSdk } from '@vercel/board/sync-chat-sdk'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Drops } from './drops.ts'

export type GoogleChatSync = {
  credentials: { client_email: string; private_key: string }
  projectNumber: string
  botUserId?: string
  channelsBySpace?: Record<string, string>
}

type AddOnEvent = {
  chat?: { messagePayload?: { space?: { type?: string; spaceType?: string } } }
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

async function callerRefusal(request: Request, endpointUrl: string, identity: string): Promise<string | null> {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return 'no bearer token'
  try {
    const { payload } = await jwtVerify(header.slice('Bearer '.length), googleKeys, { issuer: GOOGLE_ISSUERS, audience: endpointUrl })
    return payload.email === identity && payload.email_verified === true ? null : 'a token for another identity'
  } catch (error) {
    return `an invalid token (${(error as { code?: unknown }).code ?? 'unreadable'})`
  }
}

function parsed(body: string): AddOnEvent | null {
  try {
    const event = JSON.parse(body) as unknown
    return event && typeof event === 'object' ? (event as AddOnEvent) : null
  } catch {
    return null
  }
}

const isDirectMessage = (event: AddOnEvent) => {
  const space = event.chat?.messagePayload?.space
  return space?.type === 'DM' || space?.spaceType === 'DIRECT_MESSAGE'
}

const withoutRaw = (emit: Receive): Receive => (received) => emit({ ...received, raw: null })

export function gchat(options: GoogleChatSync, endpointUrl: string, drops: Drops): SyncProvider {
  const identity = `service-${options.projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
  const adapter = createGoogleChatAdapter({
    credentials: options.credentials,
    endpointUrl,
    workspaceAddOnServiceAccountEmail: identity,
    googleChatProjectNumber: '',
    pubsubTopic: '',
    pubsubAudience: '',
    pubsubServiceAccountEmail: '',
    impersonateUser: '',
    disableSignatureVerification: false,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
  })
  const provider = chatSdk({ adapter, platform: 'gchat' }, channels(options.channelsBySpace ?? {}))
  const receive = provider.receive.bind(provider)
  provider.receive = async (key, request, emit) => {
    const event = parsed(await request.clone().text())
    if (!event) return new Response('Invalid JSON', { status: 400 })
    const refusal = await callerRefusal(request, endpointUrl, identity)
    if (refusal) {
      drops.record('gchat', 'refused_token', refusal)
      return new Response('Unauthorized', { status: 401 })
    }
    if (isDirectMessage(event)) {
      drops.record('gchat', 'direct_message')
      return Response.json({})
    }
    return receive(key, request, withoutRaw(emit))
  }
  return provider
}
