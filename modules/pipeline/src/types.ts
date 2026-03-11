export interface StageConfig {
  name: string;
  command: string;
  timeout: number;
}

export interface PipelineConfig {
  stages: StageConfig[];
}

export type StageStatus = 'pass' | 'fail' | 'timeout' | 'skipped';

export interface StageResult {
  name: string;
  status: StageStatus;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export type PipelineStatus = 'pass' | 'fail';

export interface PipelineResult {
  runId: string;
  commitSha: string;
  branch: string;
  startedAt: string;
  durationMs: number;
  status: PipelineStatus;
  stages: StageResult[];
}

export interface DiffInput {
  diffText: string;
  commitSha: string;
  branch: string;
}
