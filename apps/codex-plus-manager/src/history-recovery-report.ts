export type FrontendRecoveryReport = {
  status: "pending" | "completed" | "partial" | "unavailable" | "skipped";
  reason?: string | null;
  loadedPages: number;
  metadataPages: number;
};

export function historyRecoveryStatusLabel(
  report: FrontendRecoveryReport,
  tr: (text: string) => string = (text) => text,
): string {
  switch (report.status) {
    case "pending": return tr("后台补载中");
    case "completed": return tr("已完成");
    case "partial": return tr("部分完成");
    case "unavailable": return tr("不可用");
    case "skipped": return tr("已跳过");
  }
}
