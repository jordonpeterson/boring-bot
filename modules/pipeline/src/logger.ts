import { appendFile } from 'node:fs/promises';
import type { PipelineResult, StageResult } from './types.js';

const MAX_OUTPUT_CHARS = 50_000;

function truncateStageOutput(stage: StageResult): StageResult {
  if (stage.output.length <= MAX_OUTPUT_CHARS) return stage;
  return {
    ...stage,
    output: stage.output.slice(0, MAX_OUTPUT_CHARS),
  };
}

export async function appendRunLog(
  result: PipelineResult,
  logPath: string,
): Promise<void> {
  const entry: PipelineResult = {
    ...result,
    stages: result.stages.map(truncateStageOutput),
  };
  const line = JSON.stringify(entry) + '\n';
  await appendFile(logPath, line, 'utf8');
}
