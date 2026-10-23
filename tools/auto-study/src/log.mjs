import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export class Logger {
  constructor(logDir, tag = 'run') {
    mkdirSync(logDir, { recursive: true });
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    this.file = join(
      logDir,
      `${tag}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.log`,
    );
    this.events = [];
    writeFileSync(this.file, '', 'utf8');
  }

  write(level, message, extra) {
    const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
    const line = `[${stamp()}] ${level.padEnd(5)} ${message}${suffix}`;
    appendFileSync(this.file, `${line}\n`, 'utf8');
    const color = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '\x1b[36m';
    process.stdout.write(`${color}${line}\x1b[0m\n`);
  }

  info(message, extra) {
    this.write('INFO', message, extra);
  }

  warn(message, extra) {
    this.write('WARN', message, extra);
  }

  error(message, extra) {
    this.write('ERROR', message, extra);
  }

  step(message, extra) {
    const line = `\n${'─'.repeat(18)} ${message} ${'─'.repeat(18)}`;
    process.stdout.write(`\x1b[35m${line}\x1b[0m\n`);
    appendFileSync(this.file, `${line}\n`, 'utf8');
    if (extra !== undefined) {
      const text = JSON.stringify(extra, null, 2);
      process.stdout.write(`\x1b[35m${text}\x1b[0m\n`);
      appendFileSync(this.file, `${text}\n`, 'utf8');
    }
  }
}
