import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArchiveRestore, ArrowLeft, ArrowRight, CheckSquare, ChevronDown, Copy, History, Loader2, RefreshCw, RotateCcw, Search, ShieldAlert, Trash2, Wrench, X } from "lucide-react";
import { ManagementDrawer, PageHeader } from "../ManagementPages";
import { matchesManagementQuery } from "../management-model";
import { claudeSessionGroups, deletionCounts, selectableSessionKeys, type ClaudeSession, type ClaudeSessionPage, type DeleteOutcome } from "../claude-sessions-model";
import { t, tf } from "../i18n";
import "../claude-sessions.css";

type Response<T> = T & { status: string; message: string };
type Preview = { token: string; sessions: ClaudeSession[]; fileCount: number; backupRoot: string };
type Backup = { token: string; title: string; sessionId: string; cwd: string; createdAtMs: number; complete: boolean; restored: boolean; fileCount: number };
type Block = { kind: string; name: string; text: string };
type Message = { id: string; role: string; timestampMs: number | null; blocks: Block[] };
type Messages = { messages: Message[]; offset: number; limit: number; totalCount: number; hasMore: boolean; warnings: string[] };

async function request<T>(command: string, args?: Record<string, unknown>): Promise<Response<T>> {
  const result = await invoke<Response<T>>(command, args);
  if (result.status === "failed") throw new Error(result.message);
  return result;
}

function Action({ children, onClick, disabled, primary }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return <button type="button" className={`mg-button ${primary ? "mg-primary" : ""}`} disabled={disabled} onClick={onClick}>{children}</button>;
}

function IconAction({ children, label, onClick, disabled }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="mg-icon-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return <details className="claude-session-warning"><summary><ShieldAlert size={14}/>{tf("{0} 条读取提示", [warnings.length])}</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>;
}

function time(value: number | null) { return value ? new Date(value).toLocaleString() : t("未知时间"); }

function timeGroup(key: string) {
  return ({ today: t("今天"), yesterday: t("昨天"), week: t("本周"), earlier: t("更早") })[key] ?? key;
}

function MessageContent({ block }: { block: Block }) {
  if (block.kind === "text") return <div className="claude-message-text">{block.text}</div>;
  if (["tool_use", "tool_result", "thinking"].includes(block.kind)) {
    return <details className="claude-message-tool"><summary><Wrench size={14}/>{block.kind === "thinking" ? t("思考") : block.name || t("工具结果")}</summary><pre>{block.text}</pre></details>;
  }
  return <div className="claude-message-attachment">{t("附件")} · {block.kind}{block.name ? ` · ${block.name}` : ""}</div>;
}

function SessionDetail({ session, onClose }: { session: ClaudeSession; onClose: () => void }) {
  const [page, setPage] = useState<Messages | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    request<Messages>("read_claude_session", { key: session.key, offset, limit: 50 })
      .then((result) => { if (current) setPage(result); })
      .catch((reason) => { if (current) setError(String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [session.key, offset, revision]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(session.id); setCopied(true); }
    catch (reason) { setError(String(reason)); }
  };
  return <ManagementDrawer title={session.title || t("未命名会话")} onClose={onClose} footer={
    <Action onClick={() => void copy()}><Copy size={14}/>{copied ? t("已复制") : t("复制会话 ID")}</Action>
  }>
    <div className="claude-session-detail">
      <dl className="mg-detail">
        <dt>{t("项目目录")}</dt><dd>{session.cwd || t("未记录项目路径")}</dd>
        <dt>{t("会话 ID")}</dt><dd><code>{session.id}</code></dd>
        <dt>{t("创建时间")}</dt><dd>{time(session.createdAtMs)}</dd>
        <dt>{t("更新时间")}</dt><dd>{time(session.updatedAtMs)}</dd>
        <dt>{t("会话文件")}</dt><dd>{session.transcriptPath}</dd>
        <dt>{t("文件大小")}</dt><dd>{(session.fileSize / 1024).toFixed(1)} KiB</dd>
      </dl>
      <Warnings warnings={[...session.warnings, ...(page?.warnings ?? [])]}/>
      {session.protectedReason && <p className="claude-session-warning">{session.protectedReason}</p>}
      {error && <div role="alert" className="claude-session-error">{error}<Action onClick={() => setRevision((value) => value + 1)}>{t("重试")}</Action></div>}
      {loading ? <div className="claude-session-loading" role="status"><Loader2 size={18} className="claude-session-spinner"/>{t("正在读取对话…")}</div>
        : !error && <div className="claude-conversation">{page?.messages.length ? page.messages.map((message) => <article key={message.id} className="claude-message" data-role={message.role}>
          <header><strong>{message.role === "user" ? t("你") : message.role === "assistant" ? "Claude" : t("附件")}</strong><time>{time(message.timestampMs)}</time></header>
          {message.blocks.map((block, index) => <MessageContent block={block} key={index}/>)}
        </article>) : <p className="claude-session-muted">{t("没有可显示的对话内容")}</p>}</div>}
      <div className="mg-pagination">
        <Action disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ArrowLeft size={14}/>{t("上一页")}</Action>
        <span>{tf("{0} 条消息", [page?.totalCount ?? 0])}</span>
        <Action disabled={loading || !page?.hasMore} onClick={() => setOffset(offset + 50)}><ArrowRight size={14}/>{t("下一页")}</Action>
      </div>
    </div>
  </ManagementDrawer>;
}

export function ClaudeSessionsScreen() {
  const [view, setView] = useState<"sessions" | "backups">("sessions");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [mode, setMode] = useState<"project" | "time">("project");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ClaudeSessionPage | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupWarnings, setBackupWarnings] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<ClaudeSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [outcomes, setOutcomes] = useState<DeleteOutcome[]>([]);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query); setOffset(0); }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    const load = view === "sessions"
      ? request<ClaudeSessionPage>("list_claude_sessions", { query: debouncedQuery, offset, limit: 50 }).then((result) => {
        if (current) { setPage(result); setSelected(new Set()); }
      })
      : request<{ backups: Backup[]; warnings: string[] }>("list_claude_session_backups").then((result) => {
        if (current) { setBackups(result.backups); setBackupWarnings(result.warnings); }
      });
    load.catch((reason) => { if (current) setError(String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [view, debouncedQuery, offset, revision]);

  const disabled = busy || loading || query !== debouncedQuery;
  const groups = claudeSessionGroups(page?.sessions ?? [], mode);
  const filteredBackups = backups.filter((backup) => matchesManagementQuery([backup.title, backup.cwd, backup.sessionId], debouncedQuery));
  const visibleBackups = filteredBackups.slice(offset, offset + 50);
  const refresh = () => setRevision((value) => value + 1);
  const switchView = (next: "sessions" | "backups") => {
    setView(next); setOffset(0); setSelected(new Set()); setError(""); setNotice(""); setOutcomes([]);
  };
  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const operate = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(""); setNotice(""); setOutcomes([]);
    try { await task(); }
    catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const deleteSessions = (keys: string[], projectPath?: string) => operate(async () => {
    const preview = await request<Preview>("preview_claude_session_deletion", { keys, projectPath: projectPath ?? null });
    if (!mounted.current) return;
    const approved = await confirm(
      tf("删除 {0} 个会话？将备份会话文件和关联记录。\n请先完全退出 Claude 桌面端和 CLI。\n\n备份目录：{1}\n\n{2}", [
        preview.sessions.length, preview.backupRoot,
        preview.sessions.slice(0, 6).map((session) => session.title || session.id).join("\n"),
      ]),
      { title: t("删除会话"), kind: "warning", okLabel: t("删除"), cancelLabel: t("取消") },
    );
    if (!approved || !mounted.current) return;
    const result = await request<{ outcomes: DeleteOutcome[]; stopped: boolean }>("delete_claude_sessions", { token: preview.token });
    if (!mounted.current) return;
    const counts = deletionCounts(result.outcomes, preview.sessions.length);
    setOutcomes(result.outcomes);
    setNotice(tf("已删除 {0} 个，失败 {1} 个，未处理 {2} 个", [counts.deleted, counts.failed, counts.unprocessed]));
    setSelected(new Set());
    refresh();
  });
  const restore = (backup: Backup) => operate(async () => {
    const approved = await confirm(
      tf("恢复会话“{0}”？请先完全退出 Claude 桌面端和 CLI。\n已有不同内容时将停止恢复。\n\n{1}", [backup.title || backup.sessionId, backup.cwd]),
      { title: t("恢复会话"), kind: "warning", okLabel: t("恢复"), cancelLabel: t("取消") },
    );
    if (!approved || !mounted.current) return;
    await request("restore_claude_session", { token: backup.token });
    if (mounted.current) { setNotice(t("会话已恢复")); refresh(); }
  });

  return <div className="mg-page mg-session-page claude-sessions-page" aria-busy={busy || loading}>
    <PageHeader icon={<History size={20}/>} title={t("会话")} actions={<>
      <Action disabled={busy} onClick={refresh}><RefreshCw size={14}/>{t("刷新列表")}</Action>
      {view === "sessions" && <Action disabled={disabled} onClick={() => { setSelection(!selection); setSelected(new Set()); }}><CheckSquare size={14}/>{t("选择多个…")}</Action>}
    </>}/>
    <div className="mg-tabs-bar"><div className="mg-tabs" role="tablist" aria-label={t("会话视图")}>
      <button type="button" role="tab" aria-selected={view === "sessions"} data-active={view === "sessions"} disabled={busy} onClick={() => switchView("sessions")}><History size={14}/>{t("会话")}</button>
      <button type="button" role="tab" aria-selected={view === "backups"} data-active={view === "backups"} disabled={busy} onClick={() => switchView("backups")}><ArchiveRestore size={14}/>{t("删除备份")}</button>
    </div></div>
    <div className="mg-session-controls">
      <div className="mg-search"><Search size={15}/><input value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索标题、目录或会话 ID")} aria-label={t("搜索标题、目录或会话 ID")}/>{query && <IconAction disabled={busy} label={t("清除搜索")} onClick={() => setQuery("")}><X size={14}/></IconAction>}</div>
      {view === "sessions" && <div className="mg-segmented">
        <button type="button" data-active={mode === "project"} aria-pressed={mode === "project"} onClick={() => setMode("project")}>{t("按项目")}</button>
        <button type="button" data-active={mode === "time"} aria-pressed={mode === "time"} onClick={() => setMode("time")}>{t("按时间")}</button>
      </div>}
      {selection && view === "sessions" && <>
        <Action disabled={disabled} onClick={() => setSelected(new Set(selectableSessionKeys(page?.sessions ?? [])))}>{t("全选当前列表")}</Action>
        <Action primary disabled={disabled || !!error || !selected.size} onClick={() => void deleteSessions([...selected])}><Trash2 size={14}/>{tf("删除已选（{0}）", [selected.size])}</Action>
      </>}
    </div>
    <div className="claude-session-feedback" aria-live="polite">
      {busy && <div role="status"><Loader2 size={15} className="claude-session-spinner"/>{t("正在处理，请稍候…")}</div>}
      {error && <div className="claude-session-error" role="alert">{error}<Action disabled={busy} onClick={refresh}>{t("重试")}</Action></div>}
      {notice && <div>{notice}</div>}
      {!!outcomes.length && <details><summary>{t("操作结果")}</summary><ul>{outcomes.map((outcome) => <li key={outcome.key}><strong>{outcome.title || outcome.key}</strong> · {outcome.message}{outcome.backupToken && <code>{outcome.backupToken}</code>}</li>)}</ul></details>}
      <Warnings warnings={view === "sessions" ? page?.warnings ?? [] : backupWarnings}/>
    </div>
    <div className="mg-content"><div className="mg-session-list">
      {loading ? <div className="mg-empty" role="status"><Loader2 size={20} className="claude-session-spinner"/>{t("正在读取会话…")}</div>
        : view === "sessions" ? !page?.sessions.length ? <div className="mg-empty"><h2>{t("还没有匹配的会话")}</h2><Action onClick={refresh}>{t("刷新")}</Action></div>
          : groups.map((group) => {
            const open = !!debouncedQuery || expanded.has(group.key) || groups.length === 1;
            return <section key={group.key}>
              <div className="mg-group-row"><button type="button" className="mg-group-head" aria-expanded={open} onClick={() => setExpanded((current) => {
                const next = new Set(current); next.has(group.key) ? next.delete(group.key) : next.add(group.key); return next;
              })}><ChevronDown size={15} className={open ? "" : "mg-chevron-collapsed"}/><strong>{mode === "time" ? timeGroup(group.key) : group.label}</strong><span title={group.path}>{group.path}</span><small>{tf("{0} 个会话", [group.sessions.length])}</small></button>
                {mode === "project" && group.sessions[0].cwd && <IconAction disabled={disabled || !!error} label={t("删除该项目的全部会话")} onClick={() => void deleteSessions([], group.sessions[0].cwd)}><Trash2 size={15}/></IconAction>}
              </div>
              {open && group.sessions.map((session) => <article className="mg-session-row" key={session.key}>
                <div className="mg-session-check">{selection && <input type="checkbox" aria-label={tf("选择会话“{0}”", [session.title || session.id])} disabled={disabled || !!session.protectedReason} checked={selected.has(session.key)} onChange={() => toggle(session.key)}/>}</div>
                <button type="button" className="mg-session-main" onClick={() => setDetail(session)}><strong>{session.title || t("未命名会话")}</strong><small title={session.cwd}>{session.cwd || t("未记录项目路径")}</small><code>{session.id}</code></button>
                <div className="mg-session-meta"><span>{session.desktop ? t("桌面端关联") : "Claude Code"}</span><time>{time(session.updatedAtMs)}</time></div>
                <div className="mg-row-actions">{session.protectedReason && <span title={session.protectedReason} aria-label={session.protectedReason}><ShieldAlert size={15}/></span>}<IconAction disabled={disabled || !!error || !!session.protectedReason} label={session.protectedReason || t("删除会话")} onClick={() => void deleteSessions([session.key])}><Trash2 size={15}/></IconAction></div>
              </article>)}
            </section>;
          })
        : !visibleBackups.length ? <div className="mg-empty"><h2>{t("还没有删除备份")}</h2></div>
          : visibleBackups.map((backup) => <article className="claude-backup-row" key={backup.token}>
            <div><strong>{backup.title || backup.sessionId}</strong><small>{backup.cwd}</small><code>{backup.token}</code></div>
            <div className="mg-session-meta"><span>{backup.restored ? t("已恢复") : backup.complete ? t("已备份") : t("部分操作")}</span><time>{time(backup.createdAtMs)}</time><small>{tf("{0} 个文件", [backup.fileCount])}</small></div>
            <IconAction disabled={disabled || backup.restored} label={t("恢复会话")} onClick={() => void restore(backup)}><RotateCcw size={16}/></IconAction>
          </article>)}
    </div></div>
    <div className="mg-pagination">
      <Action disabled={disabled || (view === "sessions" ? !page?.offset : !offset)} onClick={() => setOffset(Math.max(0, (view === "sessions" ? page?.offset ?? 0 : offset) - 50))}><ArrowLeft size={14}/>{t("上一页")}</Action>
      <span>{view === "sessions" ? `${Math.floor((page?.offset ?? 0) / 50) + 1} · ${page?.totalCount ?? 0}` : `${Math.floor(offset / 50) + 1} · ${filteredBackups.length}`}</span>
      <Action disabled={disabled || !(view === "sessions" ? page?.hasMore : offset + 50 < filteredBackups.length)} onClick={() => setOffset((view === "sessions" ? page?.offset ?? 0 : offset) + 50)}><ArrowRight size={14}/>{t("下一页")}</Action>
    </div>
    {detail && <SessionDetail key={detail.key} session={detail} onClose={() => setDetail(null)}/>}
  </div>;
}
