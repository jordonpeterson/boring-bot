import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/runner.ts';
import type { PipelineConfig, DiffInput } from '../src/types.ts';

const diff: DiffInput = {
  diffText: 'diff --git a/foo.ts b/foo.ts\n+added line\n',
  commitSha: 'abc123',
  branch: 'refs/heads/main',
};

describe('runPipeline', () => {
  it('returns status "pass" when all stages pass', async () => {
    const config: PipelineConfig = {
      stages: [
        { name: 'Pass1', command: 'exit 0', timeout: 5000 },
        { name: 'Pass2', command: 'exit 0', timeout: 5000 },
      ],
    };
    const result = await runPipeline(config, diff);
    assert.equal(result.status, 'pass');
    assert.equal(result.stages.length, 2);
    assert.equal(result.stages[0].status, 'pass');
    assert.equal(result.stages[1].status, 'pass');
  });

  it('returns status "fail" when first stage fails', async () => {
    const config: PipelineConfig = {
      stages: [
        { name: 'Fail', command: 'exit 1', timeout: 5000 },
        { name: 'ShouldSkip', command: 'exit 0', timeout: 5000 },
      ],
    };
    const result = await runPipeline(config, diff);
    assert.equal(result.status, 'fail');
  });

  it('skips remaining stages after first failure (fail-fast)', async () => {
    const config: PipelineConfig = {
      stages: [
        { name: 'Fail', command: 'exit 1', timeout: 5000 },
        { name: 'ShouldSkip', command: 'exit 0', timeout: 5000 },
      ],
    };
    const result = await runPipeline(config, diff);
    assert.equal(result.stages[0].status, 'fail');
    assert.equal(result.stages[1].status, 'skipped');
    assert.equal(result.stages[1].exitCode, null);
    assert.equal(result.stages[1].durationMs, 0);
  });

  it('returns fail with descriptive output when stage binary is missing', async () => {
    const config: PipelineConfig = {
      stages: [
        { name: 'Missing', command: 'nonexistent-binary-xyz', timeout: 5000 },
      ],
    };
    const result = await runPipeline(config, diff);
    assert.equal(result.status, 'fail');
    assert.equal(result.stages[0].status, 'fail');
    assert.ok(
      result.stages[0].output.length > 0,
      'Expected descriptive error output',
    );
  });

  it('includes runId, commitSha, branch, startedAt, durationMs in result', async () => {
    const config: PipelineConfig = {
      stages: [{ name: 'Pass', command: 'exit 0', timeout: 5000 }],
    };
    const result = await runPipeline(config, diff);
    assert.ok(result.runId.length > 0);
    assert.equal(result.commitSha, 'abc123');
    assert.equal(result.branch, 'refs/heads/main');
    assert.ok(result.startedAt.includes('T'), 'Expected ISO 8601 startedAt');
    assert.ok(result.durationMs >= 0);
  });
});
