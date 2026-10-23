import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../packages/logging/src/index';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'zhihuishu-stage1-logs-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('minimal ordinary logging', () => {
  it('flushes asynchronous entries in order as parseable JSON lines', async () => {
    const logger = new Logger(directory);
    logger.log('INFO', 'app', 'APP_STARTED');
    logger.log('WARNING', 'browser', 'BROWSER_DISCONNECTED');
    expect(await logger.flush()).toBe(true);
    const files = await readdir(join(directory, 'logs'));
    const entries = (await readFile(join(directory, 'logs', files[0]), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.code)).toEqual(['APP_STARTED', 'BROWSER_DISCONNECTED']);
    expect(logger.healthy).toBe(true);
  });

  it('never echoes an arbitrary input code, raw error, URL, token or page content', async () => {
    const logger = new Logger(directory);
    const syntheticSecret = 'password=synthetic-only Cookie=session-synthetic question=synthetic';
    logger.log('ERROR', 'security', syntheticSecret);
    expect(await logger.flush()).toBe(true);
    const entries = logger.readEntries();
    expect(entries[0].code).toBe('UNKNOWN_EVENT');
    expect(JSON.stringify(entries)).not.toContain(syntheticSecret);
    const file = (await readdir(join(directory, 'logs')))[0];
    expect(await readFile(join(directory, 'logs', file), 'utf8')).not.toContain(syntheticSecret);
  });

  it('returns independent history copies', () => {
    const logger = new Logger(directory);
    logger.log('INFO', 'app', 'APP_STARTED');
    const history = logger.readEntries();
    history[0].message = 'tampered';
    expect(logger.readEntries()[0].message).not.toBe('tampered');
    return logger.flush();
  });

  it('keeps queue and visible history bounded and reports overflow', async () => {
    const onFailure = vi.fn();
    const logger = new Logger(directory, { onFailure });
    for (let index = 0; index < 600; index++) logger.log('INFO', 'app', 'APP_STARTED');
    expect(logger.readEntries()).toHaveLength(500);
    expect(onFailure).toHaveBeenCalled();
    expect(logger.healthy).toBe(false);
    expect(await logger.flush()).toBe(false);
  });

  it('reports actual write failure and finishes flush without an unbounded retry loop', async () => {
    await writeFile(join(directory, 'logs'), 'blocked-directory');
    const onFailure = vi.fn();
    const logger = new Logger(directory, { onFailure });
    logger.log('ERROR', 'app', 'APP_FAILED');
    expect(await logger.flush(100)).toBe(false);
    expect(onFailure).toHaveBeenCalled();
    expect(logger.healthy).toBe(false);
  });
});
