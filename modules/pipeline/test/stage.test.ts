import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStage } from '../src/stage.ts';
import type { StageConfig } from '../src/types.ts';

describe('runStage', () => {
  it('returns status "pass" when command exits 0', async () => {
    const stage: StageConfig = { name: 'Echo', command: 'echo hello', timeout: 5000 };
    const result = await runStage(stage, '');
    assert.equal(result.status, 'pass');
    assert.equal(result.exitCode, 0);
    assert.equal(result.name, 'Echo');
    assert.ok(result.durationMs >= 0);
  });

  it('returns status "fail" when command exits non-zero', async () => {
    const stage: StageConfig = { name: 'Fail', command: 'exit 1', timeout: 5000 };
    const result = await runStage(stage, '');
    assert.equal(result.status, 'fail');
    assert.notEqual(result.exitCode, 0);
  });

  it('captures combined stdout and stderr in output', async () => {
    const stage: StageConfig = {
      name: 'Output',
      command: 'sh -c "echo stdout; echo stderr >&2"',
      timeout: 5000,
    };
    const result = await runStage(stage, '');
    assert.ok(result.output.includes('stdout'), `output: ${result.output}`);
    assert.ok(result.output.includes('stderr'), `output: ${result.output}`);
  });

  it('returns status "timeout" when command exceeds timeout', async () => {
    const stage: StageConfig = { name: 'Slow', command: 'sleep 10', timeout: 200 };
    const result = await runStage(stage, '');
    assert.equal(result.status, 'timeout');
    assert.ok(result.durationMs < 3000, `Expected fast timeout, got ${result.durationMs}ms`);
  });

  it('returns status "fail" with descriptive message for missing binary', async () => {
    const stage: StageConfig = {
      name: 'Missing',
      command: 'nonexistent-binary-xyz-abc',
      timeout: 5000,
    };
    const result = await runStage(stage, '');
    assert.equal(result.status, 'fail');
    assert.ok(
      result.output.includes('nonexistent-binary-xyz-abc') || result.output.includes('not found') || result.output.includes('ENOENT'),
      `Expected descriptive error, got: ${result.output}`,
    );
  });

  it('passes diff text to stage via stdin', async () => {
    const stage: StageConfig = {
      name: 'Stdin',
      command: 'sh -c "cat"',
      timeout: 5000,
    };
    const diff = 'diff --git a/foo.ts b/foo.ts\n+added line\n';
    const result = await runStage(stage, diff);
    assert.ok(result.output.includes('added line'), `output: ${result.output}`);
  });

  it('sets PIPELINE_COMMIT_SHA in child process environment', async () => {
    const stage: StageConfig = {
      name: 'Env SHA',
      command: 'sh -c "echo $PIPELINE_COMMIT_SHA"',
      timeout: 5000,
    };
    const result = await runStage(stage, '', 'abc123sha', 'refs/heads/main');
    assert.ok(result.output.includes('abc123sha'), `output: ${result.output}`);
  });

  it('sets PIPELINE_BRANCH in child process environment', async () => {
    const stage: StageConfig = {
      name: 'Env Branch',
      command: 'sh -c "echo $PIPELINE_BRANCH"',
      timeout: 5000,
    };
    const result = await runStage(stage, '', 'sha', 'refs/heads/feat/my-feature');
    assert.ok(result.output.includes('refs/heads/feat/my-feature'), `output: ${result.output}`);
  });
});
