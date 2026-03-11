import type { StageResult, PipelineResult } from './types.js';

const useColor = (): boolean => !process.env['NO_COLOR'];

const PASS = '✓';
const FAIL = '✗';
const TIMEOUT = '⊙';
const SEP = '━'.repeat(50);
const SUM_SEP = '═'.repeat(50);

function green(s: string): string {
  return useColor() ? `\x1b[32m${s}\x1b[0m` : s;
}
function red(s: string): string {
  return useColor() ? `\x1b[31m${s}\x1b[0m` : s;
}
function yellow(s: string): string {
  return useColor() ? `\x1b[33m${s}\x1b[0m` : s;
}
function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

function formatDuration(ms: number): string {
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

export function reportStageStart(name: string): void {
  process.stdout.write(`\n${SEP}\n`);
  process.stdout.write(`${bold('▶')}  ${bold(name)}\n`);
  process.stdout.write(`${SEP}\n`);
}

export function reportStageEnd(result: StageResult): void {
  if (result.output.trim()) {
    process.stdout.write(`${result.output}\n`);
  }

  const duration = formatDuration(result.durationMs);

  if (result.status === 'pass') {
    process.stdout.write(`${green(PASS)}  ${bold(result.name)}  ${green(`(${duration})`)}\n`);
  } else if (result.status === 'timeout') {
    process.stdout.write(
      `${yellow(TIMEOUT)}  ${bold(result.name)}  ${yellow('(timeout)')}\n`,
    );
  } else {
    const code = result.exitCode !== null ? ` exit code ${result.exitCode}` : '';
    process.stdout.write(
      `${red(FAIL)}  ${bold(result.name)}  ${red(`(${duration}${code})`)}\n`,
    );
  }
}

export function reportSummary(result: PipelineResult): void {
  const duration = formatDuration(result.durationMs);
  process.stdout.write(`\n${SUM_SEP}\n`);
  if (result.status === 'pass') {
    process.stdout.write(`${green(bold(`PIPELINE PASSED  (${duration})`))} \n`);
  } else {
    process.stdout.write(`${red(bold(`PIPELINE FAILED  (${duration})`))} \n`);
  }
  process.stdout.write(`${SUM_SEP}\n`);
}
