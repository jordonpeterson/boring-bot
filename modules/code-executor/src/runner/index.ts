import { query } from '@anthropic-ai/claude-agent-sdk'
import type { RunnerConfig } from '../types.js'
import { cloneRepos } from './clone-repos.js'
import { checkoutRepos } from './checkout-repos.js'

const raw = process.env['CLAUDE_RUN_CONFIG']
if (!raw) {
  process.stderr.write(JSON.stringify({ type: 'fatal', error: 'CLAUDE_RUN_CONFIG env var is missing' }) + '\n')
  process.exit(1)
}

let config: RunnerConfig
try {
  config = JSON.parse(raw) as RunnerConfig
} catch (err) {
  process.stderr.write(JSON.stringify({ type: 'fatal', error: `Failed to parse CLAUDE_RUN_CONFIG: ${String(err)}` }) + '\n')
  process.exit(1)
}

async function main(): Promise<void> {
  // Clone repos before starting the agent
  if (config.repos?.length) {
    await cloneRepos(config.repos)
  }

  // Checkout branches and run setup steps
  if (config.setupRepos?.length) {
    await checkoutRepos(config.setupRepos)
  }

  let seq = 0

  const stream = query({
    prompt: config.prompt,
    options: {
      // Defaults — overridden by anything in config.options
      allowedTools: ['Read', 'Write', 'Bash', 'Edit'],
      maxTurns: 50,
      permissionMode: 'default',
      ...config.options,
      // cwd is always /workspace inside the container, regardless of config
      cwd: '/workspace',
    },
  })

  for await (const event of stream) {
    process.stdout.write(JSON.stringify({ seq, ts: Date.now(), event }) + '\n')
    seq++
  }
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify({ type: 'fatal', error: String(err) }) + '\n')
  process.exit(1)
})
