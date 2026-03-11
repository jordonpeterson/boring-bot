import { readFile } from 'node:fs/promises';
import type { PipelineConfig, StageConfig } from './types.js';

export async function loadConfig(configPath: string): Promise<PipelineConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(
      `Cannot read pipeline.config.json at "${configPath}". ` +
        `Ensure the file exists at the repository root.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to JSON parse pipeline.config.json: ${(err as Error).message}`,
    );
  }

  return validate(parsed);
}

function validate(value: unknown): PipelineConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pipeline.config.json must be a JSON object.');
  }

  const obj = value as Record<string, unknown>;

  if (!Array.isArray(obj['stages'])) {
    throw new Error('pipeline.config.json must have a "stages" array.');
  }

  const stages = obj['stages'] as unknown[];

  if (stages.length === 0) {
    throw new Error(
      'pipeline.config.json "stages" array must not be empty — add at least one stage.',
    );
  }

  return { stages: stages.map(validateStage) };
}

function validateStage(value: unknown, index: number): StageConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Stage at index ${index} must be an object.`);
  }

  const s = value as Record<string, unknown>;

  if (typeof s['name'] !== 'string' || s['name'].trim() === '') {
    throw new Error(
      `Stage at index ${index} is missing a valid "name" string field.`,
    );
  }

  if (typeof s['command'] !== 'string' || s['command'].trim() === '') {
    throw new Error(
      `Stage "${s['name']}" (index ${index}) is missing a valid "command" string field.`,
    );
  }

  if (
    typeof s['timeout'] !== 'number' ||
    !Number.isInteger(s['timeout']) ||
    s['timeout'] <= 0
  ) {
    throw new Error(
      `Stage "${s['name']}" (index ${index}) must have a "timeout" that is a positive integer (milliseconds).`,
    );
  }

  return {
    name: s['name'] as string,
    command: s['command'] as string,
    timeout: s['timeout'] as number,
  };
}
