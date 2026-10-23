import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

/** Internal acceptance capability only. Never construct from IPC/config or persist its callback. */
export interface VerifiedPracticeGrant {
  readonly id: string;
  readonly courseId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly evidence: 'manual-ai-tutor-note-v1';
  readonly claim: (signal: AbortSignal) => Promise<boolean>;
}
export function validPracticeGrant(grant: VerifiedPracticeGrant, now = Date.now()): boolean {
  return (
    !!grant &&
    /^[a-zA-Z0-9_-]{8,128}$/.test(grant.id) &&
    /^zhs_c_[a-f0-9]{64}$/.test(grant.courseId) &&
    grant.evidence === 'manual-ai-tutor-note-v1' &&
    typeof grant.claim === 'function' &&
    Number.isFinite(grant.issuedAt) &&
    Number.isFinite(grant.expiresAt) &&
    grant.issuedAt <= now &&
    now < grant.expiresAt &&
    grant.expiresAt > grant.issuedAt &&
    grant.expiresAt - grant.issuedAt <= 600000
  );
}

/** A durable exclusive claim prevents reuse across engine/process reconstruction. Never remove it. */
export function createVerifiedPracticeGrant(
  directory: string,
  courseId: string,
  manualConfirmed: true,
): VerifiedPracticeGrant {
  if (manualConfirmed !== true) throw new Error('MANUAL_SCOPE_CONFIRMATION_REQUIRED');
  const issuedAt = Date.now();
  const values = {
    id: randomUUID(),
    courseId,
    issuedAt,
    expiresAt: issuedAt + 600000,
    evidence: 'manual-ai-tutor-note-v1' as const,
  };
  const grant: VerifiedPracticeGrant = Object.freeze({
    ...values,
    claim: async (signal: AbortSignal) => {
      try {
        signal.throwIfAborted();
        if (!validPracticeGrant(grant)) return false;
        await mkdir(directory, { recursive: true });
        signal.throwIfAborted();
        const file = await open(join(directory, 'practice-claim.json'), 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(values) + '\n', 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!validPracticeGrant(grant)) throw new Error('INVALID_PRACTICE_GRANT');
  return grant;
}
