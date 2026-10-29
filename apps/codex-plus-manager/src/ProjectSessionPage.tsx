import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, ChevronDown, Copy, History, Info, RefreshCw, Search, Trash2 } from "lucide-react";
import { SessionBackups } from "./SessionBackups";
import { t, tf } from "./i18n";
import { sessionGroups, type ManagedSession } from "./management-model";
import { ManagementDrawer } from "./ManagementPages";
import "./ManagementPages.css";

type SessionPageData = { sessions: ManagedSession[]; totalCount: number; hasMore: boolean; offset: number; limit: number };
function Button({ children, className = "", danger, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <button type="button" className={`mg-button ${danger ? "mg-session-danger" : ""} ${className}`} {...props}>{children}</button>;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="mg-search"><Search size={14} /><input aria-label={placeholder} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></div>;
}

export function ProjectSessionPage({
  sessions,
  loading = false,
  onRefresh,
  onDelete,
  onDeleteMany,
  onArchiveMany,
  onListProjectSessions,
  repairPanel,
  onDeleteProject,
  notify,
}: {
  sessions: SessionPageData | null;
  loading?: boolean;
  onRefresh: (offset?: number, query?: string) => Promise<void>;
  onDelete: (session: ManagedSession) => Promise<boolean | void>;
  // 返回 false 表示用户取消或没有执行，此时保留当前选择。
  onDeleteMany: (sessions: ManagedSession[]) => Promise<boolean | void>;
  onArchiveMany: (sessions: ManagedSession[], archived?: boolean) => Promise<boolean | void>;
  onListProjectSessions: (cwd: string) => Promise<ManagedSession[]>;
  repairPanel?: ReactNode;
  onDeleteProject?: (cwd: string, label: string) => Promise<void>;
  notify: (title: string, message: string, status?: "ok" | "failed") => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"sessions" | "backups">("sessions");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [mode, setMode] = useState<"project" | "time">("project");
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [selection, setSelection] = useState(false);
  const [selected, setSelected] = useState<Map<string, ManagedSession>>(new Map());
  const [detail, setDetail] = useState<ManagedSession | null>(null);
  const [projectLoading, setProjectLoading] = useState<string | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++revision.current; };
  }, []);
  useEffect(() => {
    ++revision.current;
    if (query === submittedQuery) return;
    const timer = setTimeout(() => {
      setSubmittedQuery(query);
      setDetail(null);
      void refresh.current(0, query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, submittedQuery]);
  const disabled = loading || operationPending || projectLoading !== null || query !== submittedQuery;
  const all = sessions?.sessions || [];
  const visible = all;
  const groups = sessionGroups(visible, mode);
  const selectedRows = [...selected.values()];
  const toggle = (session: ManagedSession) => setSelected((old) => {
    const next = new Map(old);
    if (next.has(session.id)) next.delete(session.id); else next.set(session.id, session);
    return next;
  });
  const selectCurrentPage = () => setSelected((old) => {
    const next = new Map(old);
    visible.forEach((session) => next.set(session.id, session));
    return next;
  });
  const selectProject = async (cwd: string) => {
    if (!cwd || disabled || pending.current) return;
    pending.current = true;
    const current = revision.current;
    setProjectLoading(cwd);
    try {
      const projectSessions = await onListProjectSessions(cwd);
      if (!mounted.current || current !== revision.current) return;
      setSelected((old) => {
        const next = new Map(old);
        projectSessions.forEach((session) => next.set(session.id, session));
        return next;
      });
    } catch (error) {
      if (mounted.current && current === revision.current) await notify(t("调用失败"), String(error), "failed");
    } finally {
      pending.current = false;
      if (mounted.current) setProjectLoading(null);
    }
  };
  const runOperation = async (operation: () => Promise<void>) => {
    if (disabled || pending.current) return;
    pending.current = true;
    setOperationPending(true);
    try { await operation(); }
    catch (error) { if (mounted.current) await notify(t("调用失败"), String(error), "failed"); }
    finally { pending.current = false; if (mounted.current) setOperationPending(false); }
  };
  const deleteSelected = async () => {
    if (!selectedRows.length) return;
    if ((await onDeleteMany(selectedRows)) !== false && mounted.current) setSelected(new Map());
  };
  const archiveSelected = async () => {
    if (!selectedRows.length) return;
    if ((await onArchiveMany(selectedRows, true)) !== false && mounted.current) setSelected(new Map());
  };
  // 选择可以跨分页（整项目选择），不能按当前页修剪；单删成功的会话要移出选择，
  // 否则随后的批量操作会把已删除的会话再提交一次并报失败。
  const deleteOne = async (session: ManagedSession) => {
    if ((await onDelete(session)) === true && mounted.current) {
      setSelected((old) => {
        if (!old.has(session.id)) return old;
        const next = new Map(old);
        next.delete(session.id);
        return next;
      });
    }
  };
  const pageSize = sessions?.limit || 50;
  const page = sessions ? Math.floor(sessions.offset / pageSize) + 1 : 0;
  const tabs = <div className="mg-tabs-bar"><div className="mg-tabs" role="tablist" aria-label={t("会话视图")}>
    <button type="button" role="tab" aria-selected={view === "sessions"} data-active={view === "sessions"} disabled={operationPending} onClick={() => setView("sessions")}><History size={14}/>{t("会话")}</button>
    <button type="button" role="tab" aria-selected={view === "backups"} data-active={view === "backups"} disabled={operationPending} onClick={() => setView("backups")}><ArchiveRestore size={14}/>{t("删除备份")}</button>
  </div></div>;
  if (view === "backups") return <div className="mg-page mg-session-page">{tabs}<SessionBackups /></div>;
  return <div className="mg-page mg-session-page">
    {tabs}
    <div className="mg-session-toolbar">
      <SearchBox value={query} onChange={(value) => { ++revision.current; setQuery(value); setExpanded(new Map()); }} placeholder={t("搜索标题、目录或会话 ID")} />
      <div className="mg-segmented" role="group" aria-label={t("会话视图")}>
        <button type="button" data-active={mode === "project"} aria-pressed={mode === "project"} onClick={() => setMode("project")}>{t("按项目")}</button>
        <button type="button" data-active={mode === "time"} aria-pressed={mode === "time"} onClick={() => setMode("time")}>{t("按时间")}</button>
      </div>
      <div className="mg-session-toolbar-actions">
        <Button disabled={disabled} className="mg-session-refresh" onClick={() => void onRefresh(0, query)} title={t("刷新列表")} aria-label={t("刷新列表")}><RefreshCw size={15} aria-hidden="true" /></Button>
        <Button disabled={disabled} aria-pressed={selection} onClick={() => { setSelection((old) => !old); setSelected(new Map()); }}>{selection ? t("完成") : t("选择多个…")}</Button>
      </div>
    </div>
    {repairPanel}
    {selection ? <div className="mg-session-selection">
      <div className="mg-session-selection-actions">
        <span className="mg-session-selected-count" role="status" aria-live="polite">{tf("已选择 {0}", [selectedRows.length])}</span>
        <Button disabled={disabled} onClick={selectCurrentPage}>{t("全选当前列表")}</Button>
        <Button disabled={disabled || !selectedRows.length} onClick={() => setSelected(new Map())}>{t("取消全部选择")}</Button>
        <div className="mg-session-batch-actions">
          <Button disabled={disabled || !selectedRows.length} onClick={() => void runOperation(archiveSelected)}><Archive size={14} aria-hidden="true" />{t("归档已选")}</Button>
          <Button danger disabled={disabled || !selectedRows.length} onClick={() => void runOperation(deleteSelected)}><Trash2 size={14} aria-hidden="true" />{tf("删除已选 ({0})", [selectedRows.length])}</Button>
        </div>
      </div>
      <p className="mg-session-selection-hint"><Info size={14} aria-hidden="true" /><span>{t("删除会创建本地备份；如果 Codex App 正在使用该会话，建议先关闭对应会话窗口再操作。")}</span></p>
    </div> : null}
    <div className="mg-content" aria-busy={disabled}>
      <div className="mg-session-list">
        {!visible.length ? <div className="mg-empty"><h2>{disabled ? t("加载中…") : t("还没有匹配的会话")}</h2><Button disabled={disabled} onClick={() => void onRefresh(0, query)}>{t("刷新")}</Button></div> : groups.map((group, index) => {
          const open = expanded.get(group.key) ?? Boolean(query.trim() || groups.length === 1);
          const groupId = `session-group-${mode}-${index}`;
          return <section className="mg-session-group" key={group.key}>
            <div className="mg-session-group-header" data-mode={mode}>
              <button type="button" className="mg-session-group-toggle" aria-expanded={open} aria-controls={groupId} onClick={() => setExpanded((old) => new Map(old).set(group.key, !open))}>
                <ChevronDown size={15} aria-hidden="true" className={open ? "" : "mg-chevron-collapsed"} />
                <span className="mg-session-group-text"><strong title={group.label}>{group.label}</strong>{group.path ? <small title={group.path}>{group.path}</small> : null}</span>
                <span className="mg-session-group-count">{group.sessions.length} {t("个会话")}</span>
              </button>
              {selection && mode === "project" && group.path ? <Button className="mg-session-select-project" disabled={disabled} onClick={() => void selectProject(group.path)}>{projectLoading === group.path ? t("读取中…") : t("全选项目")}</Button> : null}
              {mode === "project" && group.path && onDeleteProject ? <Button disabled={disabled} className="mg-icon-button mg-group-delete" title={t("删除该项目的全部会话")} aria-label={t("删除该项目的全部会话")} onClick={() => void runOperation(() => onDeleteProject(group.path, group.label))}><Trash2 size={15} /></Button> : null}
            </div>
            <div id={groupId} hidden={!open}>
              {open && group.sessions.map((session) => <article className="mg-session-row" data-selection={selection} key={session.id}>
                {selection ? <div className="mg-session-check"><input type="checkbox" disabled={disabled} aria-label={`${t("已选择")}：${session.title || session.id}`} checked={selected.has(session.id)} onChange={() => toggle(session)} /></div> : null}
                <button type="button" className="mg-session-main" onClick={() => setDetail(session)}>
                  <strong title={session.title}>{session.title || t("未命名会话")}</strong>
                  <small title={mode === "time" ? session.cwd : session.modelProvider}>{mode === "time" ? session.cwd || t("未记录项目路径") : session.modelProvider || "Codex"}</small>
                </button>
                <div className="mg-session-meta"><time>{session.updatedAtMs ? new Date(session.updatedAtMs).toLocaleString() : t("未知时间")}</time></div>
                <div className="mg-row-actions"><button type="button" disabled={disabled} className="mg-icon-button mg-session-delete" onClick={() => void runOperation(() => deleteOne(session))} aria-label={`${t("删除会话")}：${session.title || session.id}`} title={t("删除会话")}><Trash2 size={15} aria-hidden="true" /></button></div>
              </article>)}
            </div>
          </section>;
        })}
      </div>
    </div>
    <div className="mg-pagination">
      <span>{sessions ? tf("第 {0} 页 · 共 {1} 个会话", [page, sessions.totalCount]) : "—"}</span>
      <div className="mg-session-page-actions">
        <Button onClick={() => void onRefresh(Math.max(0, (sessions?.offset || 0) - pageSize), query)} disabled={disabled || !sessions?.offset}><ArrowLeft size={14} aria-hidden="true" />{t("上一页")}</Button>
        <Button onClick={() => void onRefresh((sessions?.offset || 0) + pageSize, query)} disabled={disabled || !sessions?.hasMore}>{t("下一页")}<ArrowRight size={14} aria-hidden="true" /></Button>
      </div>
    </div>
    {detail ? <ManagementDrawer title={detail.title || t("未命名会话")} onClose={() => setDetail(null)} footer={<><Button onClick={() => void navigator.clipboard.writeText(detail.id).catch(error => notify(t("调用失败"), String(error), "failed"))}><Copy size={14} />{t("复制会话 ID")}</Button><Button danger disabled={disabled} onClick={() => void runOperation(() => deleteOne(detail))}><Trash2 size={14} />{t("删除会话")}</Button></>}><dl className="mg-detail"><dt>{t("会话 ID")}</dt><dd>{detail.id}</dd><dt>{t("项目目录")}</dt><dd>{detail.cwd || "—"}</dd><dt>{t("模型供应商")}</dt><dd>{detail.modelProvider || "Codex"}</dd><dt>{t("数据库")}</dt><dd>{detail.dbPath || "—"}</dd></dl></ManagementDrawer> : null}
  </div>;
}
