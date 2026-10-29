import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { appConfirm } from "./app-dialog";
import { t, tf } from "./i18n";
import "./claude-sessions.css";

type Backup = { token: string; sessionId: string; title: string; createdAtMs: number; fileCount: number };
type Page = { backups: Backup[]; warnings: string[] };
type Result<T> = T & { status: string; message: string };

export function SessionBackups() {
  const [page, setPage] = useState<Page>({ backups: [], warnings: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [offset, setOffset] = useState(0);
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
        setOffset((value) => Math.min(value, Math.max(0, Math.ceil(result.backups.length / 50) - 1) * 50));
        setError("");
      }
    } catch (reason) {
      if (mounted.current && current === generation.current) setError(String(reason));
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
    setNotice("");
    try {
      const restore = command === "restore_local_session_backup";
      const approved = await appConfirm(question, {
        title: restore ? t("恢复会话") : t("清理备份"),
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
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = loading || busy;
  const visible = page.backups.slice(offset, offset + 50);
  return <>
    <div className="mg-session-controls">
      <span>{t("保留最新 20 份及 7 天内的全部备份")}</span>
      <button type="button" className="mg-button" disabled={disabled} onClick={() => void operate("cleanup_local_session_backups", t("清理超过 7 天且不在最新 20 份内的备份？清理后无法恢复这些备份。"))}><Trash2 size={14}/>{t("清理过期备份")}</button>
      <button type="button" className="mg-icon-button" disabled={disabled} title={t("刷新列表")} aria-label={t("刷新列表")} onClick={() => void load()}><RefreshCw size={15}/></button>
    </div>
    <div className="claude-session-feedback" aria-live="polite">
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!!page.warnings.length && <details><summary>{t("备份读取提示")}</summary><ul>{page.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    </div>
    <div className="mg-content" aria-busy={disabled}>
      {loading && !page.backups.length ? <div className="mg-empty" role="status"><Loader2 size={18}/>{t("正在读取…")}</div>
        : !visible.length ? <div className="mg-empty">{t("还没有删除备份")}</div>
          : visible.map((backup) => <article className="claude-backup-row" key={backup.token}>
            <div><strong>{backup.title || backup.sessionId}</strong><code>{backup.token}</code></div>
            <div className="mg-session-meta"><time>{new Date(backup.createdAtMs).toLocaleString()}</time><small>{tf("{0} 个文件", [backup.fileCount])}</small></div>
            <div className="mg-row-actions">
              <button type="button" className="mg-icon-button" disabled={disabled} title={t("恢复会话")} aria-label={t("恢复会话")} onClick={() => void operate("restore_local_session_backup", t("恢复此会话备份？请先完全退出 Codex、ChatGPT 和 VS Code Codex。已有不同内容时停止恢复。"), backup)}><RotateCcw size={16}/></button>
              <button type="button" className="mg-icon-button" disabled={disabled} title={t("删除备份")} aria-label={t("删除备份")} onClick={() => void operate("delete_local_session_backup", t("永久删除这份备份？原会话不受影响，此备份将无法恢复。"), backup)}><Trash2 size={16}/></button>
            </div>
          </article>)}
    </div>
    <div className="mg-pagination">
      <button type="button" className="mg-button" disabled={disabled || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("上一页")}</button>
      <span>{Math.floor(offset / 50) + 1} · {page.backups.length}</span>
      <button type="button" className="mg-button" disabled={disabled || offset + 50 >= page.backups.length} onClick={() => setOffset(offset + 50)}>{t("下一页")}</button>
    </div>
  </>;
}
