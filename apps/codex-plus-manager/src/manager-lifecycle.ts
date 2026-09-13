type VisibleRefreshOptions = {
  refresh: (isCurrent: () => boolean) => Promise<unknown>;
  intervalMs: number;
  onError: (error: unknown) => void;
};

/** 事件和定时刷新共用一个队列；隐藏时不调度，恢复后补读一次。 */
export function createVisibleRefresh({ refresh, intervalMs, onError }: VisibleRefreshOptions) {
  let visible = false;
  let disposed = false;
  let running = false;
  let requested = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const drain = async () => {
    if (disposed || !visible || running || !requested) return;
    requested = false;
    running = true;
    const currentRevision = revision;
    try {
      await refresh(() => !disposed && visible && revision === currentRevision);
    } catch (error) {
      if (!disposed) onError(error);
    } finally {
      running = false;
      if (!disposed && visible) {
        if (requested) void drain();
        else timer = setTimeout(request, intervalMs);
      }
    }
  };

  const request = () => {
    if (disposed) return;
    requested = true;
    clearTimer();
    void drain();
  };

  return {
    request,
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      revision += 1;
      clearTimer();
      if (visible) request();
    },
    dispose() {
      disposed = true;
      revision += 1;
      clearTimer();
    },
  };
}
