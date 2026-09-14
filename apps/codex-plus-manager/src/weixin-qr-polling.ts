import { createVisibleRefresh } from "./manager-lifecycle.ts";

type QrStatus = { status: string; qrStatus: string };

export function isWeixinQrPending(qrStatus: string): boolean {
  return ["", "wait", "scaned"].includes(qrStatus);
}

/** 扫码独立于窗口可见性；终态和错误停止，销毁后丢弃未返回的结果。 */
export function startWeixinQrPolling<T extends QrStatus>({
  read,
  onResult,
  onConfirmed,
  onError,
}: {
  read: () => Promise<T>;
  onResult: (result: T) => void;
  onConfirmed: (isCurrent: () => boolean) => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  const refresh = createVisibleRefresh({
    intervalMs: 1_000,
    refresh: async (isCurrent) => {
      const result = await read();
      if (!isCurrent()) return;
      const success = result.status === "ok" || result.status === "accepted";
      const terminal = !success || !isWeixinQrPending(result.qrStatus);
      // 确认后的补读完成再更新二维码状态，避免 effect 因终态清理而中断补读。
      if (success && result.qrStatus === "confirmed") {
        await onConfirmed(isCurrent);
        if (!isCurrent()) return;
      }
      onResult(result);
      if (terminal) refresh.dispose();
    },
    onError: (error) => {
      refresh.dispose();
      onError(error);
    },
  });
  refresh.setVisible(true);
  return () => refresh.dispose();
}
