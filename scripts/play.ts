/**
 * Edit run.config.ts, then run:
 *
 *   pnpm play                                  # hits localhost:3001 (local server)
 *   SERVER_URL=http://localhost:3000 pnpm play  # hits the Docker-backed server
 */
import { CodeExecutorClient, prettyPrint } from '@boring-bot/code-executor-client'
import config from './run.config.js'

const client = new CodeExecutorClient({
  url:       process.env['SERVER_URL'] ?? 'http://localhost:3000',
  authToken: process.env['AUTH_TOKEN'] ?? 'dev-token',
})

for await (const event of client.run(config)) {
  prettyPrint(event)
}
