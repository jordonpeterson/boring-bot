import { startServer } from './server.js'
import type { Credentials } from './types.js'

function getCredentials(): Promise<Credentials> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (apiKey) return Promise.resolve({ type: 'api_key', value: apiKey })

  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  if (oauthToken) return Promise.resolve({ type: 'oauth_token', value: oauthToken })

  throw new Error('Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set')
}

await startServer({
  authToken: process.env['AUTH_TOKEN'] ?? 'dev-token',
  host: process.env['HOST'] ?? '0.0.0.0',
  port: Number(process.env['PORT'] ?? 3000),
  getCredentials,
})
