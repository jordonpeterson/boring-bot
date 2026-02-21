import type { ExecuteOptions } from '@boring-bot/code-executor'

const config: ExecuteOptions = {
  prompt: `
    Can you tell if you are running in an isolated docker container or on my mac? What is the root directory and user called? 
   
  `,

  // Tools Claude is allowed to use. Remove any you want to restrict.
  allowedTools: ['Read', 'Write', 'Bash', 'Edit'],

  // Stop after this many agent turns.
  maxTurns: 50,

  // 'default'            — prompts before dangerous ops
  // 'acceptEdits'        — auto-accepts file edits
  // 'bypassPermissions'  — skips all permission checks
  permissionMode: 'bypassPermissions',

  // The agent's writable workspace, mounted at /workspace inside the container.
  // The agent cannot access anything above this directory.
  // If omitted, a fresh directory is auto-created per run at /tmp/boring-bot-logs/<runId>.
  // agentDir: '/path/to/agent-dir',

  // Mount a local directory read-only at /workspace/context inside the container.
  // contextPath: '/path/to/your/code',

  // Resume a previous session. Grab the session_id from a prior run's result event.
  // resume: 'abc-123',
}

export default config
