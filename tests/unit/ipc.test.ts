import { describe, expect, it } from 'vitest';
import { parseCommand, validateSender } from '../../apps/desktop/main/ipc.js';

const envelope = (command: string, payload?: unknown) => ({
  command,
  correlationId: 'correlation-123',
  ...(payload === undefined ? {} : { payload }),
});
describe('IPC安全白名单', () => {
  it('只信任指定窗口的本地主框架', () => {
    const sender = {
      senderId: 1,
      expectedSenderId: 1,
      frameUrl: 'file:///app/index.html',
      expectedUrl: 'file:///app/index.html',
      isMainFrame: true,
    };
    expect(validateSender(sender)).toBe(true);
    expect(validateSender({ ...sender, isMainFrame: false })).toBe(false);
    expect(validateSender({ ...sender, senderId: 2 })).toBe(false);
    expect(validateSender({ ...sender, frameUrl: 'https://example.com' })).toBe(false);
    expect(validateSender({ ...sender, frameUrl: 'file:///app/index.html?x' })).toBe(false);
  });
  it.each(['page.click', 'fs.readFile', 'browser.evaluate', 'practice.submit', 'shell.openPath'])(
    '拒绝未知能力 %s',
    (command) => {
      expect(parseCommand(envelope(command))).toBeNull();
    },
  );
  it.each([null, [], {}, 'task.start', { command: 'task.start', correlationId: 'x' }])(
    '拒绝无效信封',
    (input) => {
      expect(parseCommand(input)).toBeNull();
    },
  );
  it('无参命令不可夹带任意路径、选择器或凭据', () => {
    expect(parseCommand(envelope('task.start', { path: 'C:/secret' }))).toBeNull();
    expect(parseCommand({ ...envelope('task.start'), token: 'secret' })).toBeNull();
    expect(parseCommand(envelope('settings.update', { cookie: 'secret' }))).toBeNull();
    expect(
      parseCommand(envelope('settings.update', { __proto__: { allowGraded: true } })),
    ).toBeNull();
  });
  it('允许结构化意图且限制配置patch', () => {
    expect(parseCommand(envelope('task.pause'))?.command).toBe('task.pause');
    expect(parseCommand(envelope('settings.update', { pollIntervalMs: 10000 }))?.payload).toEqual({
      pollIntervalMs: 10000,
    });
    expect(parseCommand(envelope('settings.update', { schemaVersion: 1 }))).toBeNull();
    expect(parseCommand(envelope('settings.update', { pollIntervalMs: '3000' }))).toBeNull();
    expect(parseCommand(envelope('settings.update', { pollIntervalMs: Infinity }))).toBeNull();
  });
  it('阶段3隐私配置只接受显式布尔值，不能带动作许可或凭据', () => {
    expect(
      parseCommand(envelope('settings.update', { practiceAllowFullText: true }))?.payload,
    ).toEqual({ practiceAllowFullText: true });
    expect(parseCommand(envelope('settings.update', { practiceAllowFullText: 1 }))).toBeNull();
    expect(parseCommand(envelope('settings.update', { stage3FixturePractice: true }))).toBeNull();
  });
  it('课程确认必须明确ID且无附加字段', () => {
    expect(parseCommand(envelope('course.confirm', { courseId: 'fixture-course' }))).not.toBeNull();
    expect(
      parseCommand(envelope('course.confirm', { courseId: 'fixture-course', force: true })),
    ).toBeNull();
  });
});
