import type { Credentials } from '@boring-bot/code-executor'

export function getCredentials(): Promise<Credentials> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (apiKey) return Promise.resolve({ type: 'api_key', value: apiKey })

  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  if (oauthToken) return Promise.resolve({ type: 'oauth_token', value: oauthToken })

  throw new Error('Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set')
}
