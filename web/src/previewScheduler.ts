type Timer = ReturnType<typeof setTimeout> | number;

interface PreviewSchedulerOptions {
  delayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}

/** Keep a live preview responsive without extending the debounce forever under SSE updates. */
export function createLatestPreviewScheduler(options: PreviewSchedulerOptions = {}) {
  const delayMs = options.delayMs ?? 180;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  let timer: Timer | undefined;
  let latest: (() => void) | undefined;

  return {
    schedule(task: () => void): void {
      latest = task;
      if (timer !== undefined) return;
      timer = schedule(() => {
        timer = undefined;
        const next = latest;
        latest = undefined;
        next?.();
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
      latest = undefined;
    },
    isScheduled(): boolean {
      return timer !== undefined;
    }
  };
}

interface PreviewRequest<T> {
  task: () => Promise<T>;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}

export function createLatestPreviewQueue<T>(options: PreviewSchedulerOptions = {}) {
  const scheduler = createLatestPreviewScheduler(options);
  let latest: PreviewRequest<T> | undefined;
  let inFlight = false;
  let queued = false;

  const flush = (): void => {
    if (!latest) return;
    if (inFlight) {
      queued = true;
      return;
    }
    const request = latest;
    latest = undefined;
    inFlight = true;
    void request.task()
      .then(request.onSuccess, request.onError)
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          scheduler.schedule(flush);
        }
        request.onSettled();
      });
  };

  return {
    schedule(request: PreviewRequest<T>): void {
      latest = request;
      scheduler.schedule(flush);
    },
    cancel(): void {
      scheduler.cancel();
      latest = undefined;
      queued = false;
    },
    isPending(): boolean {
      return inFlight || latest !== undefined || scheduler.isScheduled();
    }
  };
}
