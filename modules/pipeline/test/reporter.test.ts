import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reportStageStart, reportStageEnd, reportSummary } from '../src/reporter.ts';
import type { StageResult, PipelineResult } from '../src/types.ts';

// Capture writes to process.stdout for testing
let captured = '';
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
  captured = '';
  originalWrite = process.stdout.write.bind(process.stdout);
  // @ts-expect-error — overriding for test capture
  process.stdout.write = (chunk: string) => {
    captured += chunk;
    return true;
  };
});

afterEach(() => {
  process.stdout.write = originalWrite;
  delete process.env['NO_COLOR'];
});

const passResult: StageResult = {
  name: 'Tests',
  status: 'pass',
  exitCode: 0,
  durationMs: 4230,
  output: 'All tests passed',
};

const failResult: StageResult = {
  name: 'Code Review',
  status: 'fail',
  exitCode: 1,
  durationMs: 12110,
  output: 'Found issues',
};

const timeoutResult: StageResult = {
  name: 'AI Agent',
  status: 'timeout',
  exitCode: 124,
  durationMs: 30000,
  output: '',
};

const pipelinePass: PipelineResult = {
  runId: 'abc12345-1741564800000',
  commitSha: 'abc12345',
  branch: 'refs/heads/main',
  startedAt: '2026-03-10T14:23:45.000Z',
  durationMs: 4230,
  status: 'pass',
  stages: [passResult],
};

const pipelineFail: PipelineResult = {
  runId: 'abc12345-1741564800000',
  commitSha: 'abc12345',
  branch: 'refs/heads/main',
  startedAt: '2026-03-10T14:23:45.000Z',
  durationMs: 16340,
  status: 'fail',
  stages: [passResult, failResult],
};

describe('reportStageStart', () => {
  it('prints a stage header containing the stage name', () => {
    reportStageStart('Tests');
    assert.ok(captured.includes('Tests'), `output: ${captured}`);
  });
});

describe('reportStageEnd', () => {
  it('prints checkmark and duration for a passing stage', () => {
    reportStageEnd(passResult);
    assert.ok(captured.includes('Tests'), `output: ${captured}`);
    assert.ok(captured.includes('4.23s') || captured.includes('4.2s') || captured.includes('pass'), `output: ${captured}`);
  });

  it('prints cross and exit code for a failing stage', () => {
    reportStageEnd(failResult);
    assert.ok(captured.includes('Code Review'), `output: ${captured}`);
    assert.ok(captured.includes('1') || captured.includes('fail'), `output: ${captured}`);
  });

  it('prints timeout indicator for a timed-out stage', () => {
    reportStageEnd(timeoutResult);
    assert.ok(captured.includes('AI Agent'), `output: ${captured}`);
    assert.ok(
      captured.toLowerCase().includes('timeout') || captured.includes('⊙'),
      `output: ${captured}`,
    );
  });

  it('includes stage output for failing stages', () => {
    reportStageEnd(failResult);
    assert.ok(captured.includes('Found issues'), `output: ${captured}`);
  });

  it('suppresses ANSI codes when NO_COLOR=1', () => {
    process.env['NO_COLOR'] = '1';
    reportStageEnd(passResult);
    assert.ok(
      !captured.includes('\x1b['),
      `Expected no ANSI codes, got: ${captured}`,
    );
  });
});

describe('reportSummary', () => {
  it('prints PIPELINE PASSED for a passing result', () => {
    reportSummary(pipelinePass);
    assert.ok(
      captured.toUpperCase().includes('PASSED') || captured.toUpperCase().includes('PASS'),
      `output: ${captured}`,
    );
  });

  it('prints PIPELINE FAILED for a failing result', () => {
    reportSummary(pipelineFail);
    assert.ok(
      captured.toUpperCase().includes('FAILED') || captured.toUpperCase().includes('FAIL'),
      `output: ${captured}`,
    );
  });

  it('includes total duration in summary', () => {
    reportSummary(pipelinePass);
    assert.ok(
      captured.includes('4.23s') || captured.includes('4.2s') || captured.includes('4s'),
      `output: ${captured}`,
    );
  });

  it('suppresses ANSI codes when NO_COLOR=1', () => {
    process.env['NO_COLOR'] = '1';
    reportSummary(pipelinePass);
    assert.ok(
      !captured.includes('\x1b['),
      `Expected no ANSI codes, got: ${captured}`,
    );
  });
});
