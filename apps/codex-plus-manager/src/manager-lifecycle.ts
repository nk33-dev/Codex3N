type VisibleRefreshOptions = {
  refresh: (isCurrent: () => boolean) => Promise<unknown>;
  intervalMs: number;
  onError: (error: unknown) => void;
};

/** 判断一次后台刷新结果是否仍允许提交，集中表达销毁、隐藏和版本失效条件。 */
export function isVisibleRefreshCurrent(
  disposed: boolean,
  visible: boolean,
  revision: number,
  requestRevision: number,
): boolean {
  return !disposed && visible && revision === requestRevision;
}

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
      await refresh(() => isVisibleRefreshCurrent(disposed, visible, revision, currentRevision));
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
