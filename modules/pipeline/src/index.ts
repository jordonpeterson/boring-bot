import { join } from 'node:path';
import { loadConfig } from './config.js';
import { runPipeline } from './runner.js';
import { appendRunLog } from './logger.js';
import type { DiffInput } from './types.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const commitSha = process.env['PIPELINE_COMMIT_SHA'] ?? '';
  const branch = process.env['PIPELINE_BRANCH'] ?? '';

  const diffText = await readStdin().catch((err: Error) => {
    process.stderr.write(`Failed to read diff from stdin: ${err.message}\n`);
    process.exit(1);
  });

  const configPath = join(process.cwd(), 'pipeline.config.json');
  const config = await loadConfig(configPath).catch((err: Error) => {
    process.stderr.write(`Pipeline config error: ${err.message}\n`);
    process.exit(1);
  });

  const diff: DiffInput = { diffText, commitSha, branch };
  const result = await runPipeline(config, diff);

  const logPath = join(process.cwd(), '.pipeline-runs.log');
  await appendRunLog(result, logPath).catch((err: Error) => {
    process.stderr.write(`Warning: could not write run log: ${err.message}\n`);
  });

  process.exit(result.status === 'pass' ? 0 : 1);
}

main().catch((err: Error) => {
  process.stderr.write(`Unhandled pipeline error: ${err.message}\n`);
  process.exit(1);
});
