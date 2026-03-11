import { runStage } from './stage.js';
import { reportStageStart, reportStageEnd, reportSummary } from './reporter.js';
import type { PipelineConfig, PipelineResult, DiffInput, StageResult } from './types.js';

export async function runPipeline(
  config: PipelineConfig,
  diff: DiffInput,
): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const runId = `${diff.commitSha.slice(0, 8)}-${startMs}`;

  const stageResults: StageResult[] = [];
  let failed = false;

  for (const stage of config.stages) {
    if (failed) {
      stageResults.push({
        name: stage.name,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        output: '',
      });
      continue;
    }

    reportStageStart(stage.name);
    const result = await runStage(stage, diff.diffText, diff.commitSha, diff.branch);
    reportStageEnd(result);
    stageResults.push(result);

    if (result.status !== 'pass') {
      failed = true;
    }
  }

  const pipelineResult: PipelineResult = {
    runId,
    commitSha: diff.commitSha,
    branch: diff.branch,
    startedAt,
    durationMs: Date.now() - startMs,
    status: failed ? 'fail' : 'pass',
    stages: stageResults,
  };

  reportSummary(pipelineResult);

  return pipelineResult;
}
