import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfig,
  AppEvent,
  Command,
  DesktopApi,
} from '../../../packages/contracts/src/index.js';

const invoke = (command: Command, payload?: unknown) =>
  ipcRenderer.invoke('study:command', {
    command,
    correlationId: globalThis.crypto.randomUUID(),
    ...(payload === undefined ? {} : { payload }),
  });
const api: DesktopApi = {
  status: () => invoke('app.status'),
  selfCheck: () => invoke('system.check'),
  openBrowser: () => invoke('browser.open'),
  reopenBrowser: () => invoke('browser.reopen'),
  inspectCourse: () => invoke('course.inspect'),
  confirmCourse: (courseId: string) => invoke('course.confirm', { courseId }),
  start: () => invoke('task.start'),
  pause: () => invoke('task.pause'),
  resume: () => invoke('task.resume'),
  stop: () => invoke('task.stop'),
  getSettings: () => invoke('settings.get'),
  updateSettings: (patch: Partial<AppConfig>) => invoke('settings.update', patch),
  acknowledgeSettings: () => invoke('settings.acknowledge'),
  createBackup: () => invoke('backup.create'),
  inspectRecovery: () => invoke('recovery.inspect'),
  openReport: () => invoke('report.open'),
  exportDiagnostics: () => invoke('diagnostics.export'),
  autoStart: (course?: string) => invoke('auto.start', course ? { course } : undefined),
  autoStop: () => invoke('auto.stop'),
  autoStatus: () => invoke('auto.status'),
  autoConfig: () => invoke('auto.config'),
  autoConfigSave: (patch: Record<string, unknown>) => invoke('auto.config.save', patch),
  autoProfileReset: () => invoke('auto.profile.reset'),
  autoBrowserOpen: (url?: string) => invoke('auto.browser.open', url ? { url } : undefined),
  disclaimer: () => invoke('app.disclaimer'),
  acceptDisclaimer: () => invoke('app.disclaimer.accept'),
  updateCheck: () => invoke('app.update.check'),
  updateOpen: (url: string) => invoke('app.update.open', { url }),
  quit: () => invoke('app.quit'),
  onEvent: (listener: (event: AppEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on('study:event', handler);
    return () => ipcRenderer.removeListener('study:event', handler);
  },
};
contextBridge.exposeInMainWorld('study', Object.freeze(api));
