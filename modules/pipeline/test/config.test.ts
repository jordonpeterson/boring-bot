import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

const TMP_DIR = '/tmp/pipeline-config-test';
const CONFIG_PATH = join(TMP_DIR, 'pipeline.config.json');

before(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

after(async () => {
  await unlink(CONFIG_PATH).catch(() => {});
});

async function withConfig(content: string, fn: () => Promise<void>) {
  await writeFile(CONFIG_PATH, content, 'utf8');
  await fn();
}

describe('loadConfig', () => {
  it('returns typed PipelineConfig for valid config', async () => {
    await withConfig(
      JSON.stringify({
        stages: [{ name: 'Tests', command: 'pnpm test', timeout: 30000 }],
      }),
      async () => {
        const config = await loadConfig(CONFIG_PATH);
        assert.equal(config.stages.length, 1);
        assert.equal(config.stages[0].name, 'Tests');
        assert.equal(config.stages[0].command, 'pnpm test');
        assert.equal(config.stages[0].timeout, 30000);
      },
    );
  });

  it('throws descriptive error when file is missing', async () => {
    await assert.rejects(
      () => loadConfig('/nonexistent/pipeline.config.json'),
      (err: Error) => {
        assert.ok(
          err.message.includes('pipeline.config.json'),
          `Expected message to include filename, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('throws on invalid JSON', async () => {
    await withConfig('not valid json', async () => {
      await assert.rejects(() => loadConfig(CONFIG_PATH), /JSON|parse/i);
    });
  });

  it('throws when stages array is empty', async () => {
    await withConfig(JSON.stringify({ stages: [] }), async () => {
      await assert.rejects(
        () => loadConfig(CONFIG_PATH),
        /stages.*empty|at least one/i,
      );
    });
  });

  it('throws when stage is missing name', async () => {
    await withConfig(
      JSON.stringify({ stages: [{ command: 'echo hi', timeout: 1000 }] }),
      async () => {
        await assert.rejects(() => loadConfig(CONFIG_PATH), /name/i);
      },
    );
  });

  it('throws when stage is missing command', async () => {
    await withConfig(
      JSON.stringify({ stages: [{ name: 'Tests', timeout: 1000 }] }),
      async () => {
        await assert.rejects(() => loadConfig(CONFIG_PATH), /command/i);
      },
    );
  });

  it('throws when stage is missing timeout', async () => {
    await withConfig(
      JSON.stringify({ stages: [{ name: 'Tests', command: 'echo hi' }] }),
      async () => {
        await assert.rejects(() => loadConfig(CONFIG_PATH), /timeout/i);
      },
    );
  });

  it('throws when timeout is not a positive number', async () => {
    await withConfig(
      JSON.stringify({
        stages: [{ name: 'Tests', command: 'echo hi', timeout: -1 }],
      }),
      async () => {
        await assert.rejects(() => loadConfig(CONFIG_PATH), /timeout/i);
      },
    );
  });
});
