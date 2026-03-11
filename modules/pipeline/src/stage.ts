import { spawn } from 'node:child_process';
import type { StageConfig, StageResult } from './types.js';

export async function runStage(
  stage: StageConfig,
  diff: string,
  commitSha: string = '',
  branch: string = '',
): Promise<StageResult> {
  const startMs = Date.now();

  return new Promise((resolve) => {
    const controller = new AbortController();
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PIPELINE_COMMIT_SHA: commitSha,
      PIPELINE_BRANCH: branch,
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('sh', ['-c', stage.command], {
        signal: controller.signal,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      resolve({
        name: stage.name,
        status: 'fail',
        exitCode: null,
        durationMs: Date.now() - startMs,
        output: `Failed to start stage "${stage.command}": ${(err as Error).message}`,
      });
      return;
    }

    // Start timeout
    killTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          if (proc.pid !== undefined) {
            try {
              process.kill(-proc.pid, 'SIGKILL');
            } catch {}
          }
        }, 5000);
      }
    }, stage.timeout);

    // Write diff to stdin then close
    if (diff) {
      proc.stdin?.write(diff, 'utf8');
    }
    proc.stdin?.end();

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      if (err.name === 'AbortError' || timedOut) {
        resolve({
          name: stage.name,
          status: 'timeout',
          exitCode: 124,
          durationMs: Date.now() - startMs,
          output,
        });
      } else {
        const message =
          err.code === 'ENOENT'
            ? `Command not found: "${stage.command}". Ensure it is installed and on PATH.`
            : `Stage "${stage.name}" error: ${err.message}`;
        resolve({
          name: stage.name,
          status: 'fail',
          exitCode: null,
          durationMs: Date.now() - startMs,
          output: output || message,
        });
      }
    });

    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(killTimer);
      if (timedOut) {
        resolve({
          name: stage.name,
          status: 'timeout',
          exitCode: 124,
          durationMs: Date.now() - startMs,
          output,
        });
        return;
      }
      if (signal && !timedOut) {
        resolve({
          name: stage.name,
          status: 'fail',
          exitCode: null,
          durationMs: Date.now() - startMs,
          output,
        });
        return;
      }
      const exitCode = code ?? 1;
      resolve({
        name: stage.name,
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        durationMs: Date.now() - startMs,
        output,
      });
    });
  });
}
