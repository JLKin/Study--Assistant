import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, repairConfig } from '../../contracts/src/config.js';
import type { AppConfig, ConfigView } from '../../contracts/src/index.js';

export class ConfigStore {
  private value: ConfigView = {
    config: { ...DEFAULT_CONFIG },
    issues: [],
    blocked: true,
    source: 'default',
  };
  private writable = true;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(dataDir: string) {
    this.directory = join(dataDir, 'config');
  }
  view(): ConfigView {
    return structuredClone(this.value);
  }
  async load(): Promise<ConfigView> {
    await mkdir(this.directory, { recursive: true });
    let primaryMissing = false;
    let repaired: ReturnType<typeof repairConfig>;
    let source: ConfigView['source'] = 'primary';
    try {
      repaired = repairConfig(
        JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8')),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'SCHEMA_UNSUPPORTED') return this.block();
      primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      try {
        repaired = repairConfig(
          JSON.parse(await readFile(join(this.directory, 'settings.valid.json'), 'utf8')),
        );
        source = 'backup';
        repaired.issues.push({
          key: 'document',
          reason: '从最近有效配置恢复，须确认后使用',
          requiresConfirmation: true,
        });
      } catch (backupError) {
        if (!primaryMissing || (backupError as NodeJS.ErrnoException).code !== 'ENOENT')
          return this.block();
        repaired = { config: { ...DEFAULT_CONFIG }, issues: [] };
        source = 'default';
      }
    }
    let pending = false;
    try {
      const marker: unknown = JSON.parse(
        await readFile(join(this.directory, 'repair-pending.json'), 'utf8'),
      );
      if (
        !marker ||
        typeof marker !== 'object' ||
        (marker as { schemaVersion: unknown }).schemaVersion !== 1
      )
        return this.block();
      pending = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return this.block();
    }
    const needsConfirmation = pending || repaired.issues.some((i) => i.requiresConfirmation);
    if (needsConfirmation) {
      await this.markPending();
      if (pending)
        repaired.issues.push({
          key: 'confirmation',
          reason: '上次配置修复尚未确认',
          requiresConfirmation: true,
        });
    }
    this.value = { ...repaired, blocked: needsConfirmation, source };
    await this.save(repaired.config);
    return this.view();
  }
  private block(): ConfigView {
    this.writable = false;
    this.value.blocked = true;
    this.value.issues = [
      {
        key: 'document',
        reason: '配置不可读或版本不兼容；请保留原文件并人工修复',
        requiresConfirmation: true,
      },
    ];
    return this.view();
  }
  async update(patch: Partial<AppConfig>): Promise<ConfigView> {
    if (!this.writable) throw new Error('CONFIG_BLOCKED');
    const next = this.queue
      .then(async () => {
        if (!this.writable) throw new Error('CONFIG_BLOCKED');
        const repaired = repairConfig({ ...this.value.config, ...patch });
        if (repaired.issues.some((i) => i.requiresConfirmation)) await this.markPending();
        await this.save(repaired.config);
        this.value = {
          ...repaired,
          source: 'primary',
          blocked: this.value.blocked || repaired.issues.some((i) => i.requiresConfirmation),
        };
        return this.view();
      })
      .catch((error) => {
        this.block();
        throw error;
      });
    this.queue = next.catch(() => {});
    return next;
  }
  async acknowledge(): Promise<ConfigView> {
    if (!this.writable) throw new Error('CONFIG_BLOCKED');
    const next = this.queue
      .then(async () => {
        if (!this.writable) throw new Error('CONFIG_BLOCKED');
        await this.save(this.value.config);
        await unlink(join(this.directory, 'repair-pending.json')).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        this.value.blocked = false;
        this.value.issues = [];
        return this.view();
      })
      .catch((error) => {
        this.block();
        throw error;
      });
    this.queue = next.catch(() => {});
    return next;
  }
  private async markPending(): Promise<void> {
    await this.atomic(
      'repair-pending.json',
      JSON.stringify({ schemaVersion: 1, requiresConfirmation: true }),
    );
  }
  private async atomic(name: string, text: string): Promise<void> {
    const tmp = join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, join(this.directory, name));
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
  private async save(config: AppConfig): Promise<void> {
    const text = JSON.stringify(config, null, 2);
    for (const name of ['settings.json', 'settings.valid.json']) {
      await this.atomic(name, text);
    }
  }
}
