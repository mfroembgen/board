import { serve } from 'srvx'
import { createApp } from './app.ts'

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is required`)
  return value
}

serve({
  port: Number(env('PORT', '4100')),
  hostname: env('HOST', '0.0.0.0'),
  fetch: createApp({
    url: env('BOARD_PUBLIC_URL'),
    dir: env('BOARD_DIR', '.board'),
    people: { issuer: env('AUTHKIT_ISSUER'), domain: env('TEAM_DOMAIN') },
  }),
})
