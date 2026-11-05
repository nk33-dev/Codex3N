import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ArchiveRestore, ArrowLeft, ArrowRight, Info, Loader2, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { appConfirm } from "./app-dialog";
import { ManagementDrawer } from "./ManagementPages";
import { t, tf } from "./i18n";
import "./session-backups.css";

type Backup = { token: string; sessionId: string; title: string; createdAtMs: number; fileCount: number };
type Page = { backups: Backup[]; warnings: string[] };
type Result<T> = T & { status: string; message: string };

export function SessionBackups({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const [page, setPage] = useState<Page>({ backups: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Backup | null>(null);
  const [progress, setProgress] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const load = async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await invoke<Result<Page>>("list_local_session_backups");
      if (result.status !== "ok") throw new Error(result.message);
      if (mounted.current && current === generation.current) {
        setPage(result);
        setLoadFailed(false);
        setSelected((old) => new Set([...old].filter((token) => result.backups.some((backup) => backup.token === token))));
      }
    } catch (reason) {
      if (mounted.current && current === generation.current) { setError(String(reason)); setLoadFailed(true); }
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; ++generation.current; };
  }, []);
  const operate = async (command: string, question: string, backup?: Backup) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setNotice("");
    setError("");
    try {
      const restore = command === "restore_local_session_backup";
      const approved = await appConfirm(question, {
        title: restore ? t("恢复会话") : backup ? t("删除备份") : t("清理备份"),
        confirmText: restore ? t("恢复") : t("删除备份"),
        danger: !restore,
      });
      if (!approved || !mounted.current) return;
      const result = await invoke<Result<{ removed?: number }>>(command, backup ? { token: backup.token } : {});
      if (result.status !== "ok") throw new Error(result.message);
      if (!mounted.current) return;
      setNotice(restore ? t("会话已恢复") : result.removed === undefined ? t("备份已删除") : tf("已清理 {0} 份备份", [result.removed]));
      await load();
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      locked.current = false;
      if (mounted.current) { setBusy(false); onBusyChange?.(false); }
    }
  };
  const deleteSelected = async () => {
    if (locked.current || loading || !selected.size) return;
    const targets = page.backups.filter((backup) => selected.has(backup.token));
    locked.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setNotice("");
    try {
      if (!await appConfirm(tf("永久删除选中的 {0} 份备份？原会话不受影响，删除后无法恢复。", [targets.length]), {
        title: t("删除备份"), confirmText: tf("删除 {0} 份备份", [targets.length]), danger: true,
      })) return;
      let removed = 0;
      const failures: string[] = [];
      for (const [index, backup] of targets.entries()) {
        if (!mounted.current) return;
        setProgress(tf("正在删除备份 {0}/{1}", [index + 1, targets.length]));
        try {
          const result = await invoke<Result<{}>>("delete_local_session_backup", { token: backup.token });
          if (result.status !== "ok") throw new Error(result.message);
          removed++;
          if (!mounted.current) return;
          setPage((old) => ({ ...old, backups: old.backups.filter((item) => item.token !== backup.token) }));
          setSelected((old) => { const next = new Set(old); next.delete(backup.token); return next; });
        } catch (reason) {
          failures.push(`${backup.title || backup.sessionId}: ${String(reason)}`);
        }
      }
      if (!mounted.current) return;
      setNotice(tf("已删除 {0} 份备份", [removed]));
      if (failures.length) setError(tf("{0} 份备份删除失败，已保留选择，可重试。", [failures.length]) + "\n" + failures.join("\n"));
      await load();
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      locked.current = false;
      if (mounted.current) { setBusy(false); setProgress(""); onBusyChange?.(false); }
    }
  };
  const disabled = loading || busy;
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = page.backups.filter((backup) => terms.every((term) => `${backup.title} ${backup.sessionId} ${backup.token}`.toLocaleLowerCase().includes(term)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
  const start = Math.min(offset, (pageCount - 1) * 50);
  const visible = filtered.slice(start, start + 50);
  const allVisibleSelected = visible.length > 0 && visible.every((backup) => selected.has(backup.token));
  const togglePage = () => setSelected((old) => {
    const next = new Set(old);
    visible.forEach((backup) => allVisibleSelected ? next.delete(backup.token) : next.add(backup.token));
    return next;
  });
  return <section className="session-backups" aria-label={t("删除备份")}>
    <div className="backup-toolbar">
      <div className="mg-search">
        <Search size={15} aria-hidden="true"/>
        <input aria-label={t("搜索备份标题或 ID")} placeholder={t("搜索备份标题或 ID")} value={query} disabled={busy} onChange={(event) => { setQuery(event.target.value); setOffset(0); }}/>
        {query && <button type="button" className="mg-icon-button" title={t("清除搜索")} aria-label={t("清除搜索")} disabled={busy} onClick={() => { setQuery(""); setOffset(0); }}><X size={14}/></button>}
      </div>
      <div className="backup-toolbar-actions">
      <button type="button" className="mg-button" disabled={disabled} onClick={() => void operate("cleanup_local_session_backups", t("清理超过 7 天且不在最新 20 份内的备份？清理后无法恢复这些备份。"))}><Trash2 size={14}/>{t("清理过期备份")}</button>
      <button type="button" className="mg-icon-button" disabled={disabled} title={t("刷新列表")} aria-label={t("刷新列表")} onClick={() => { setError(""); void load(); }}><RefreshCw size={15}/></button>
      </div>
    </div>
    <p className="backup-retention">{t("保留最新 20 份及 7 天内的全部备份")}</p>
    <div className="backup-feedback" aria-live="polite">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {progress && <p role="status">{progress}</p>}
      {!!page.warnings.length && <details><summary>{t("备份读取提示")}</summary><ul>{page.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    </div>
    <div className="backup-selection">
      <label className="backup-check"><input type="checkbox" aria-label={t("全选本页")} checked={allVisibleSelected} ref={(node) => { if (node) node.indeterminate = !allVisibleSelected && visible.some((backup) => selected.has(backup.token)); }} disabled={disabled || !visible.length} onChange={togglePage}/>{t("全选本页")}</label>
      <span role="status">{tf("已选择 {0}", [selected.size])}</span>
      {selected.size > 0 && <button type="button" className="mg-button" disabled={disabled} onClick={() => setSelected(new Set())}>{t("取消全部选择")}</button>}
      <button type="button" className="mg-button backup-delete" disabled={disabled || !selected.size} onClick={() => void deleteSelected()}><Trash2 size={14}/>{tf("删除已选 ({0})", [selected.size])}</button>
    </div>
    <div className="backup-list" aria-busy={disabled}>
      <div className="backup-list-head" aria-hidden="true"><span>{t("会话")}</span><span>{t("备份时间")}</span><span>{t("操作")}</span></div>
      {loading && !page.backups.length ? <div className="mg-empty" role="status"><Loader2 size={18}/>{t("正在读取…")}</div>
        : !visible.length ? <div className="mg-empty"><ArchiveRestore size={24}/><h2>{loadFailed ? t("无法读取备份") : query ? t("没有匹配的备份") : t("还没有删除备份")}</h2>{query && <button type="button" className="mg-button" onClick={() => { setQuery(""); setOffset(0); }}>{t("清除搜索")}</button>}{loadFailed && <button type="button" className="mg-button" disabled={disabled} onClick={() => { setError(""); void load(); }}>{t("重试")}</button>}</div>
          : visible.map((backup) => <article className="backup-row" data-selected={selected.has(backup.token)} key={backup.token}>
            <label className="backup-check"><input type="checkbox" aria-label={tf("选择备份：{0}", [backup.title || backup.sessionId])} checked={selected.has(backup.token)} disabled={disabled} onChange={() => setSelected((old) => { const next = new Set(old); if (next.has(backup.token)) next.delete(backup.token); else next.add(backup.token); return next; })}/></label>
            <button type="button" className="backup-title" title={backup.title || backup.sessionId} onClick={() => setDetail(backup)}><strong>{backup.title || backup.sessionId}</strong><small>{tf("{0} 个文件", [backup.fileCount])}</small></button>
            <time dateTime={new Date(backup.createdAtMs).toISOString()}>{new Date(backup.createdAtMs).toLocaleString()}</time>
            <div className="mg-row-actions">
              <button type="button" className="mg-icon-button" title={t("备份详情")} aria-label={t("备份详情")} onClick={() => setDetail(backup)}><Info size={16}/></button>
              <button type="button" className="mg-icon-button" disabled={disabled} title={t("恢复会话")} aria-label={t("恢复会话")} onClick={() => void operate("restore_local_session_backup", t("恢复此会话备份？请先完全退出 Codex、ChatGPT 和 VS Code Codex。已有不同内容时停止恢复。"), backup)}><RotateCcw size={16}/></button>
              <button type="button" className="mg-icon-button backup-delete" disabled={disabled} title={t("删除备份")} aria-label={t("删除备份")} onClick={() => void operate("delete_local_session_backup", t("永久删除这份备份？原会话不受影响，此备份将无法恢复。"), backup)}><Trash2 size={16}/></button>
            </div>
          </article>)}
    </div>
    <div className="backup-pagination">
      <span>{tf("第 {0}–{1} 份，共 {2} 份", [filtered.length ? start + 1 : 0, Math.min(start + 50, filtered.length), filtered.length])}</span>
      <div><button type="button" className="mg-icon-button" title={t("上一页")} aria-label={t("上一页")} disabled={disabled || start === 0} onClick={() => setOffset(Math.max(0, start - 50))}><ArrowLeft size={16}/></button>
      <span>{tf("第 {0}/{1} 页", [Math.floor(start / 50) + 1, pageCount])}</span>
      <button type="button" className="mg-icon-button" title={t("下一页")} aria-label={t("下一页")} disabled={disabled || start + 50 >= filtered.length} onClick={() => setOffset(start + 50)}><ArrowRight size={16}/></button></div>
    </div>
    {detail && <ManagementDrawer title={t("备份详情")} onClose={() => setDetail(null)}>
      <dl className="mg-detail backup-detail"><dt>{t("会话")}</dt><dd>{detail.title || detail.sessionId}</dd><dt>{t("会话 ID")}</dt><dd>{detail.sessionId}</dd><dt>{t("备份 ID")}</dt><dd>{detail.token}</dd><dt>{t("备份时间")}</dt><dd>{new Date(detail.createdAtMs).toLocaleString()}</dd><dt>{t("文件")}</dt><dd>{detail.fileCount}</dd></dl>
    </ManagementDrawer>}
  </section>;
}
