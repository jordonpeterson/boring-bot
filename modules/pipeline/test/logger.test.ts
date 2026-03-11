import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendRunLog } from '../src/logger.ts';
import type { PipelineResult } from '../src/types.ts';

const TMP_DIR = '/tmp/pipeline-logger-test';
const LOG_PATH = join(TMP_DIR, 'test-pipeline-runs.log');

before(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

after(async () => {
  await unlink(LOG_PATH).catch(() => {});
});

const makeResult = (status: 'pass' | 'fail' = 'pass', output = 'ok'): PipelineResult => ({
  runId: 'abc12345-123456',
  commitSha: 'abc12345abc12345abc12345abc12345abc12345',
  branch: 'refs/heads/main',
  startedAt: '2026-03-10T14:23:45.000Z',
  durationMs: 1000,
  status,
  stages: [
    {
      name: 'Tests',
      status,
      exitCode: status === 'pass' ? 0 : 1,
      durationMs: 1000,
      output,
    },
  ],
});

describe('appendRunLog', () => {
  it('creates the log file and appends a valid JSON line', async () => {
    await unlink(LOG_PATH).catch(() => {});
    await appendRunLog(makeResult(), LOG_PATH);
    const content = await readFile(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as PipelineResult;
    assert.equal(parsed.runId, 'abc12345-123456');
    assert.equal(parsed.status, 'pass');
  });

  it('includes all PipelineResult fields in the log entry', async () => {
    await unlink(LOG_PATH).catch(() => {});
    await appendRunLog(makeResult('fail'), LOG_PATH);
    const content = await readFile(LOG_PATH, 'utf8');
    const parsed = JSON.parse(content.trim()) as PipelineResult;
    assert.ok('runId' in parsed);
    assert.ok('commitSha' in parsed);
    assert.ok('branch' in parsed);
    assert.ok('startedAt' in parsed);
    assert.ok('durationMs' in parsed);
    assert.ok('status' in parsed);
    assert.ok(Array.isArray(parsed.stages));
  });

  it('appends multiple runs as separate lines (does not overwrite)', async () => {
    await unlink(LOG_PATH).catch(() => {});
    await appendRunLog(makeResult('pass'), LOG_PATH);
    await appendRunLog(makeResult('fail'), LOG_PATH);
    const content = await readFile(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const r1 = JSON.parse(lines[0]!) as PipelineResult;
    const r2 = JSON.parse(lines[1]!) as PipelineResult;
    assert.equal(r1.status, 'pass');
    assert.equal(r2.status, 'fail');
  });

  it('truncates stage output at 50,000 characters', async () => {
    await unlink(LOG_PATH).catch(() => {});
    const longOutput = 'x'.repeat(60000);
    await appendRunLog(makeResult('pass', longOutput), LOG_PATH);
    const content = await readFile(LOG_PATH, 'utf8');
    const parsed = JSON.parse(content.trim()) as PipelineResult;
    assert.ok(
      parsed.stages[0]!.output.length <= 50000,
      `Expected output ≤ 50000 chars, got ${parsed.stages[0]!.output.length}`,
    );
  });

  it('produces a single line per run (no embedded newlines in JSON)', async () => {
    await unlink(LOG_PATH).catch(() => {});
    await appendRunLog(makeResult(), LOG_PATH);
    const content = await readFile(LOG_PATH, 'utf8');
    // Should be exactly one JSON line + one trailing newline
    const lines = content.split('\n');
    assert.equal(lines.length, 2, `Expected 2 elements (line + empty), got: ${lines.length}`);
    assert.equal(lines[1], '', 'Expected trailing newline');
  });
});
