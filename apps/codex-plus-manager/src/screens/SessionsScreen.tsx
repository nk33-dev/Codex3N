import { ArrowLeft, ArrowRight, Download, Info, PackageOpen, RefreshCw, Save, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AppSelect,
  Badge,
  CardHead,
  Field,
  Panel,
  ToggleVisual,
  formatProgressPercent,
  formatTime,
  providerSyncTargetLabel,
} from "@/components/ui/manager-primitives";
import { t, tf } from "@/i18n";

import type { Actions, LocalSessionsResult, ProviderSyncProgress, ProviderSyncTargetsResult, SettingsResult } from "../App";
import type { BackendSettings } from "../provider-types";
import { isProviderSyncTargetSelectable } from "../provider-sync-target";

export function SessionsScreen({
  settings,
  form,
  sessions,
  providerSyncProgress,
  providerSyncTargets,
  selectedProviderSyncTarget,
  onFormChange,
  actions,
}: {
  settings: SettingsResult | null;
  form: BackendSettings;
  sessions: LocalSessionsResult | null;
  providerSyncProgress: ProviderSyncProgress;
  providerSyncTargets: ProviderSyncTargetsResult | null;
  selectedProviderSyncTarget: string;
  onFormChange: (value: BackendSettings) => void;
  actions: Actions;
}) {
  const items = sessions?.sessions ?? [];
  const pageOffset = sessions?.offset ?? 0;
  const pageSize = sessions?.limit ?? 50;
  const currentPage = Math.floor(pageOffset / pageSize) + 1;
  const hasPreviousPage = pageOffset > 0;
  const hasNextPage = sessions?.hasMore === true;
  const activeCount = items.filter((item) => !item.archived).length;
  const archivedCount = items.length - activeCount;
  const totalCount = sessions?.totalCount ?? items.length;
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selectedSessions = useMemo(() => items.filter((session) => selectedSessionIds.has(session.id)), [items, selectedSessionIds]);
  const selectedCount = selectedSessions.length;
  const allSelected = items.length > 0 && selectedCount === items.length;
  const providerTargets = providerSyncTargets?.targets ?? [];
  const selectedProviderTarget = providerTargets.find(
    (target) => target.id === selectedProviderSyncTarget,
  );
  const canRepairProviderSessions = selectedProviderTarget
    ? isProviderSyncTargetSelectable(selectedProviderTarget)
    : false;

  useEffect(() => {
    const itemIds = new Set(items.map((session) => session.id));
    setSelectedSessionIds((current) => {
      const next = new Set(Array.from(current).filter((id) => itemIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const toggleSessionSelection = (sessionId: string, checked: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  };

  const selectAllSessions = () => {
    setSelectionMode(true);
    setSelectedSessionIds(new Set(items.map((session) => session.id)));
  };

  const clearSelectedSessions = () => setSelectedSessionIds(new Set());

  const deleteSelectedSessions = async () => {
    if (!selectionMode) {
      setSelectionMode(true);
      return;
    }
    setBulkDeleting(true);
    try {
      await actions.deleteLocalSessions(selectedSessions);
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <>
      <Panel className="sessions-overview-panel">
        <CardHead title={t("会话管理")} detail={t("读取 Codex 本地 SQLite 会话库，会删除数据库记录和对应 rollout 文件")} />
        <CardContent className="sessions-overview-content">
          <div className="session-summary-bar">
            <div>
              <span>{t("会话总数")}</span>
              <strong>{tf("{0} 个", [totalCount])}</strong>
            </div>
            <div>
              <span>{t("当前页会话")}</span>
              <strong>{tf("{0} 个", [items.length])}</strong>
            </div>
            <div>
              <span>{t("当前页未归档")}</span>
              <strong>{tf("{0} 个", [activeCount])}</strong>
            </div>
            <div>
              <span>{t("当前页已归档")}</span>
              <strong>{tf("{0} 个", [archivedCount])}</strong>
            </div>
            <div className="session-summary-path">
              <span>{t("数据库")}</span>
              <code>{sessions?.dbPath ?? "~/.codex/sqlite/*.db"}</code>
            </div>
          </div>

          <div className="session-repair-tools">
            <Field className="session-sync-target" label={t("同步目标")}>
              <AppSelect
                disabled={providerSyncProgress.active || !providerTargets.length}
                value={selectedProviderSyncTarget}
                onChange={(value) => actions.setProviderSyncTarget(value)}
                options={
                  providerTargets.length
                    ? [
                        ...(!selectedProviderSyncTarget
                          ? [{ value: "", label: t("当前配置 provider"), disabled: true }]
                          : []),
                        ...providerTargets.map((target) => ({
                          value: target.id,
                          label: `${target.id}${t("（")}${providerSyncTargetLabel(target)}${t("）")}`,
                          disabled: !isProviderSyncTargetSelectable(target),
                          title: target.unavailableReason ?? undefined,
                        })),
                      ]
                    : [{ value: "", label: t("当前配置 provider"), disabled: true }]
                }
              />
            </Field>

            <label className="switch-row compact session-auto-repair">
              <input
                checked={form.providerSyncEnabled}
                onChange={(event) => onFormChange({ ...form, providerSyncEnabled: event.currentTarget.checked })}
                type="checkbox"
              />
              <span>
                <strong>{t("启动前自动修复历史会话")}</strong>
                <small>{t("启动 Codex 前整理旧对话的归属标记。")}</small>
              </span>
              <ToggleVisual />
            </label>

            <div className="session-repair-actions">
              <Button disabled={bulkDeleting} onClick={() => void actions.refreshLocalSessions()} variant="outline">
                <RefreshCw className="h-4 w-4" />
                {t("刷新会话")}
              </Button>
              <Button disabled={bulkDeleting} title={t("先退出 Codex 应用；检查所有本地会话，确认后备份并删除无效记录，不只是当前页。")} onClick={async () => {
                setBulkDeleting(true);
                try { await actions.deleteInvalidLocalSessions(); } finally { setBulkDeleting(false); }
              }} variant="outline">
                <Trash2 className="h-4 w-4" />
                {bulkDeleting ? t("正在检查或删除…") : t("删除无效会话")}
              </Button>
              <Button disabled={bulkDeleting} onClick={() => void actions.importLocalSession()} variant="outline">
                <PackageOpen className="h-4 w-4" />
                {t("导入文件")}
              </Button>
              <Button
                disabled={providerSyncProgress.active || !canRepairProviderSessions}
                onClick={() => void actions.syncProvidersNow()}
                variant="outline"
              >
                <Wrench className="h-4 w-4" />
                {providerSyncProgress.active ? t("正在修复…") : t("修复历史会话")}
              </Button>
              <Button onClick={() => void actions.saveSettings()}>
                <Save className="h-4 w-4" />
                {t("保存设置")}
              </Button>
            </div>
            <div className="session-share-import">
              <Input
                aria-label={t("会话分享链接")}
                onChange={(event) => actions.setSessionShareUrl(event.currentTarget.value)}
                placeholder={t("粘贴 Codex++ 会话分享链接")}
                value={actions.sessionShareUrl}
              />
              <Button disabled={!actions.sessionShareUrl.trim()} onClick={() => void actions.importSessionUrl()} variant="outline">
                <Download className="h-4 w-4" />
                {t("导入链接")}
              </Button>
            </div>
          </div>

          {providerSyncProgress.active || providerSyncProgress.percent > 0 ? (
            <div className="provider-sync-progress session-repair-progress" data-active={providerSyncProgress.active}>
              <div className="provider-sync-progress-head">
                <strong>{providerSyncProgress.active ? t("正在修复历史会话") : t("历史会话修复进度")}</strong>
                <span>{formatProgressPercent(providerSyncProgress.percent)}%</span>
              </div>
              <div
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={providerSyncProgress.percent}
                className="provider-sync-progress-bar"
                role="progressbar"
              >
                <div className="provider-sync-progress-fill" style={{ width: `${providerSyncProgress.percent}%` }} />
              </div>
              <small>{providerSyncProgress.message}</small>
            </div>
          ) : null}

          <div className="hint-line session-delete-hint">
            <Info className="h-4 w-4" />
            <span>{t("删除会创建本地备份；如果 Codex App 正在使用该会话，建议先关闭对应会话窗口再操作。")}</span>
          </div>
        </CardContent>
      </Panel>
      <Panel className="sessions-list-panel">
        <CardHead
          title={t("本地会话")}
          detail={sessions ? tf("第 {0} 页，每页最多 {1} 条，按更新时间倒序显示", [currentPage, pageSize]) : t("点击刷新会话读取本地数据库")}
        />
        <CardContent className="session-list-content">
          {items.length ? (
            <>
              <div className="session-list-toolbar">
                <span className="session-selection-summary">{t("已选择")} {selectedCount} / {items.length} {t("个会话")}</span>
                <div className="session-selection-actions">
                  <Button disabled={allSelected || bulkDeleting} onClick={selectAllSessions} size="sm" variant="outline">
                    {t("全选当前列表")}
                  </Button>
                  <Button disabled={!selectedCount || bulkDeleting} onClick={clearSelectedSessions} size="sm" variant="outline">
                    {t("清空选择")}
                  </Button>
                  <Button disabled={(selectionMode && !selectedCount) || bulkDeleting} onClick={() => void deleteSelectedSessions()} size="sm" variant="outline">
                    {selectionMode ? <Trash2 className="h-4 w-4" /> : null}
                    {selectionMode ? (bulkDeleting ? t("正在删除…") : t("删除已选")) : t("多选")}
                  </Button>
                </div>
              </div>
              <div className="session-list">
                {items.map((session) => {
                  const selected = selectedSessionIds.has(session.id);
                  return (
                    <div className="session-row" data-selection-mode={selectionMode} data-selected={selected} key={session.id}>
                      {selectionMode ? (
                        <label className="session-select" title={t("选择会话")}>
                          <input
                            aria-label={tf("选择会话 {0}", [session.title || session.id])}
                            checked={selected}
                            onChange={(event) => toggleSessionSelection(session.id, event.currentTarget.checked)}
                            type="checkbox"
                          />
                        </label>
                      ) : null}
                      <div className="session-main">
                        <strong>{session.title || t("未命名会话")}</strong>
                        <span>{session.id}</span>
                        <small>{session.cwd || t("未记录项目路径")}</small>
                      </div>
                      <div className="session-meta">
                        <Badge status={session.archived ? "archived" : "ok"} />
                        <span>{session.modelProvider || t("provider 未记录")}</span>
                        <span>{formatTime(session.updatedAtMs ?? 0)}</span>
                      </div>
                      <Button disabled={bulkDeleting} className="session-delete-button" variant="outline" onClick={() => void actions.deleteLocalSession(session)}>
                        <Trash2 className="h-4 w-4" />
                        {t("删除")}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <div className="session-pagination">
                <Button
                  aria-label={t("上一页")}
                  disabled={!hasPreviousPage || bulkDeleting}
                  onClick={() => void actions.refreshLocalSessions(true, Math.max(0, pageOffset - pageSize))}
                  size="icon"
                  title={t("上一页")}
                  variant="outline"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <span>{tf("第 {0} 页", [currentPage])}</span>
                <Button
                  aria-label={t("下一页")}
                  disabled={!hasNextPage || bulkDeleting}
                  onClick={() => void actions.refreshLocalSessions(true, pageOffset + pageSize)}
                  size="icon"
                  title={t("下一页")}
                  variant="outline"
                >
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : (
            <div className="empty">{t("未读取到本地会话，或当前 SQLite 会话库不存在。")}</div>
          )}
        </CardContent>
      </Panel>
    </>
  );
}
