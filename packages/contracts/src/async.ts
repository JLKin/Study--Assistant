/** Cancellation races even non-cooperating providers; late results are never consumed. */
export function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      controller.abort();
      cleanup();
      reject(new Error('CANCELLED'));
    };
    const timer = setTimeout(() => {
      controller.abort();
      cleanup();
      reject(new Error('TIMEOUT'));
    }, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      })
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return bounded(
    (inner) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        inner.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    signal,
    ms + 1000,
  );
}
