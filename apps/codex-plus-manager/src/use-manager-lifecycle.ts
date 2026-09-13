import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createVisibleRefresh } from "./manager-lifecycle";

const MANAGER_NAVIGATION_EVENT = "manager-navigation-requested";
const MANAGER_VISIBILITY_EVENT = "manager-visibility-changed";

type ManagerLifecycleOptions = {
  ready: boolean;
  weixinActive: boolean;
  refreshPending: () => Promise<unknown>;
  refreshWeixin: (isCurrent: () => boolean) => Promise<unknown>;
  onError: (error: unknown) => void;
};

/** 集中管理窗口可见性与后台刷新，页面组件只提供业务回调。 */
export function useManagerLifecycle(options: ManagerLifecycleOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let disposed = false;
    let nativeVisible = false;
    let visibilityRevision = 0;
    const unlisteners: Array<() => void> = [];
    const pending = createVisibleRefresh({
      refresh: () => latest.current.refreshPending(),
      intervalMs: 30_000,
      onError: (error) => latest.current.onError(error),
    });
    const updateVisibility = () => {
      const active = nativeVisible && document.visibilityState !== "hidden";
      setVisible(active);
      pending.setVisible(active && latest.current.ready);
    };
    const register = async (subscription: Promise<() => void>) => {
      try {
        const unlisten = await subscription;
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      } catch (error) {
        if (!disposed) latest.current.onError(error);
      }
    };
    const onVisibilityChange = () => {
      if (!disposed) updateVisibility();
    };
    const onFocus = () => {
      if (disposed) return;
      const wasVisible = nativeVisible && document.visibilityState !== "hidden";
      visibilityRevision += 1;
      nativeVisible = true;
      updateVisibility();
      if (wasVisible) pending.request();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    void (async () => {
      await Promise.all([
        register(listen<boolean>(MANAGER_VISIBILITY_EVENT, ({ payload }) => {
          if (disposed) return;
          visibilityRevision += 1;
          nativeVisible = payload;
          updateVisibility();
        })),
        // 导航通知不代表 show 成功，不能用它覆盖原生隐藏状态。
        register(listen(MANAGER_NAVIGATION_EVENT, () => pending.request())),
      ]);
      if (disposed) return;
      const revision = visibilityRevision;
      try {
        const appWindow = getCurrentWindow();
        const [shown, minimized] = await Promise.all([appWindow.isVisible(), appWindow.isMinimized()]);
        if (disposed || revision !== visibilityRevision) return;
        nativeVisible = shown && !minimized;
      } catch (error) {
        if (disposed || revision !== visibilityRevision) return;
        latest.current.onError(error);
        nativeVisible = document.visibilityState !== "hidden";
      }
      updateVisibility();
    })();
    return () => {
      disposed = true;
      pending.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [options.ready]);

  useEffect(() => {
    const status = createVisibleRefresh({
      refresh: (isCurrent) => latest.current.refreshWeixin(isCurrent),
      intervalMs: 2_000,
      onError: (error) => latest.current.onError(error),
    });
    status.setVisible(options.ready && options.weixinActive && visible);
    return () => status.dispose();
  }, [options.ready, options.weixinActive, visible]);
}
