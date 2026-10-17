import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CardContent } from "@/components/ui/card";
import { AppSelect, CardHead, Field, Panel } from "@/components/ui/manager-primitives";
import { t, tf } from "@/i18n";

type Project = { hostId: string; workingDirectory: string };
type Favorite = {
  id: string; title: string; body: string; tags: string[]; project: Project | null; pinned: boolean;
  createdAt?: number; updatedAt?: number; lastUsedAt?: number;
};
type Feedback = {
  id: string; original: string; generated: string; edited: string; rating: string; note: string; createdAt: number;
  history: unknown[]; metadata: { mode: string; scenario: string; model: string; systemPrompt: string };
};
type Result = { status: string; message?: string; favorites?: Favorite[]; feedback?: Feedback[]; inserted?: number; skipped?: number; document?: unknown };

async function request(action: string, payload: unknown = {}): Promise<Result> {
  const result = await invoke<Result>("prompt_tools_request", { action, payload });
  if (result.status !== "ok") throw new Error(result.message || t("读取或保存失败，请重试"));
  return result;
}

async function exportFile(kind: "library" | "feedback", payload: unknown = {}) {
  const path = await save({ defaultPath: kind === "library" ? "prompt-favorites.json" : "prompt-feedback.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  const result = await invoke<Result>("prompt_tools_export_file", { kind, path, payload });
  if (result.status !== "ok") throw new Error(result.message);
}

const emptyFavorite = (): Favorite => ({ id: "", title: "", body: "", tags: [], project: null, pinned: false });

export function PromptToolsPanel() {
  const [tab, setTab] = useState<"library" | "feedback">("library");
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("available");
  const [projectFilter, setProjectFilter] = useState("");
  const [sort, setSort] = useState("recent");
  const [rating, setRating] = useState("");
  const [edit, setEdit] = useState<Favorite | null>(null);
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [importDocument, setImportDocument] = useState<unknown>(null);
  const [importCounts, setImportCounts] = useState({ inserted: 0, skipped: 0 });
  const loadRevision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = async () => {
    const revision = ++loadRevision.current;
    const result = await request(tab === "library" ? "library/list" : "feedback/list",
      tab === "library" ? { all: true, query, scope, sort } : { query, rating });
    if (revision !== loadRevision.current) return;
    if (tab === "library") {
      setFavorites(result.favorites || []);
      if (!query && scope === "available") {
        const unique = new Map<string, Project>();
        for (const item of result.favorites || []) if (item.project) unique.set(JSON.stringify(item.project), item.project);
        setProjects([...unique.values()]);
      }
    }
    else setFeedback(result.feedback || []);
  };
  useEffect(() => {
    let alive = true;
    void request("library/list", { all: true }).then((result) => {
      if (!alive) return;
      const unique = new Map<string, Project>();
      for (const item of result.favorites || []) if (item.project) unique.set(JSON.stringify(item.project), item.project);
      setProjects([...unique.values()]);
    }).catch(() => { if (alive) setError(t("读取或保存失败，请重试")); });
    return () => { alive = false; ++loadRevision.current; };
  }, []);
  useEffect(() => { void load().catch(() => setError(t("读取或保存失败，请重试"))); return () => { ++loadRevision.current; }; }, [tab, scope, sort, rating]);

  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await task(); } catch { setError(t("读取或保存失败，请重试")); }
    finally { setBusy(false); }
  };
  const startEdit = (item: Favorite) => { setEdit({ ...item, project: item.project ? { ...item.project } : null }); setTags(item.tags.join(", ")); setError(""); };
  const remove = async (kind: string, id: string) => {
    if (!window.confirm(t("删除这条记录？删除后无法恢复。"))) return;
    await request(`${kind}/delete`, { id }); await load();
  };
  const filteredFavorites = favorites.filter((item) => !projectFilter || (item.project && JSON.stringify(item.project) === projectFilter));

  return <Panel className="enhance-service-panel prompt-tools-panel">
    <CardHead title={t("提示词工具")} detail={t("收藏常用提示词，回看主动保存的结果反馈。")} />
    <CardContent className="settings-content">
      <div className="prompt-tools-toolbar" role="group" aria-label={t("提示词工具")}>
        <Button variant={tab === "library" ? "default" : "outline"} onClick={() => { setTab("library"); setImportDocument(null); }}>{t("收藏库")}</Button>
        <Button variant={tab === "feedback" ? "default" : "outline"} onClick={() => { setTab("feedback"); setEdit(null); setImportDocument(null); }}>{t("结果反馈")}</Button>
      </div>
      <form className="prompt-tools-toolbar prompt-tools-search" onSubmit={(event) => { event.preventDefault(); void run(load); }}>
        <Input aria-label={t("搜索记录")} placeholder={t("搜索标题、正文、标签或反馈备注")} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <Button type="submit" variant="outline" disabled={busy}>{t("搜索")}</Button>
        {tab === "library" ? <Button type="button" disabled={busy} onClick={() => startEdit(emptyFavorite())}>{t("新建收藏")}</Button> : null}
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {tab === "library" ? <>
        <details className="prompt-tools-options"><summary>{t("筛选与导入导出")}</summary>
        <div className="prompt-tools-toolbar">
          <Field label={t("范围")}><AppSelect value={scope} onChange={setScope} options={[{ value: "available", label: t("全部") }, { value: "global", label: t("全局") }, { value: "project", label: t("项目") }]} /></Field>
          <Field label={t("项目筛选")}><AppSelect value={projectFilter} onChange={setProjectFilter} options={[{ value: "", label: t("全部项目") }, ...projects.map((project) => ({ value: JSON.stringify(project), label: `${project.hostId} · ${project.workingDirectory}` }))]} /></Field>
          <Field label={t("排序")}><AppSelect value={sort} onChange={setSort} options={[{ value: "recent", label: t("最近使用") }, { value: "updated", label: t("最近修改") }]} /></Field>
          <Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>{t("导入")}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await exportFile("library"); })}>{t("导出收藏")}</Button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!file) return;
            void run(async () => {
              setImportDocument(null);
              if (file.size > 8 * 1024 * 1024) throw new Error("size");
              const documentData: unknown = JSON.parse(await file.text());
              const result = await request("library/import-preview", documentData);
              setImportDocument(documentData); setImportCounts({ inserted: result.inserted || 0, skipped: result.skipped || 0 });
            });
          }} />
        </div>
        </details>
        {importDocument ? <div className="settings-block">
          <p>{tf("将导入 {0} 条，跳过 {1} 条重复收藏。", [importCounts.inserted, importCounts.skipped])}</p>
          <Button disabled={busy} onClick={() => void run(async () => {
            const result = await request("library/import", importDocument); setImportDocument(null); await load();
            setMessage(tf("已导入 {0} 条，跳过 {1} 条。", [result.inserted || 0, result.skipped || 0]));
          })}>{t("导入收藏")}</Button>
          <Button variant="outline" onClick={() => setImportDocument(null)}>{t("取消")}</Button>
        </div> : null}
        {edit ? <form className="settings-block" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await request("library/save", { ...edit, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) }); setEdit(null); await load();
          setMessage(t("收藏已保存"));
        }); }}>
          <Field label={t("标题")}><Input required maxLength={200} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.currentTarget.value })} /></Field>
          <Field label={t("正文")}><Textarea required maxLength={20000} rows={8} value={edit.body} onChange={(event) => setEdit({ ...edit, body: event.currentTarget.value })} /></Field>
          <Field label={t("标签（逗号分隔）")}><Input value={tags} onChange={(event) => setTags(event.currentTarget.value)} /></Field>
          <Field label={t("范围")}><AppSelect value={edit.project ? "project" : "global"} onChange={(value) => setEdit({ ...edit, project: value === "project" ? projects[0] || { hostId: "local", workingDirectory: "" } : null })}
            options={[{ value: "global", label: t("全局") }, { value: "project", label: t("项目") }]} /></Field>
          {edit.project ? <>
            <Field label={t("主机")}><Input required value={edit.project.hostId} onChange={(event) => setEdit({ ...edit, project: { ...edit.project!, hostId: event.currentTarget.value } })} /></Field>
            <Field label={t("项目目录")}><Input required value={edit.project.workingDirectory} onChange={(event) => setEdit({ ...edit, project: { ...edit.project!, workingDirectory: event.currentTarget.value } })} /></Field>
          </> : null}
          <label><input type="checkbox" checked={edit.pinned} onChange={(event) => setEdit({ ...edit, pinned: event.currentTarget.checked })} /> {t("置顶")}</label>
          <div className="prompt-tools-toolbar"><Button type="submit" disabled={busy}>{t("保存收藏")}</Button><Button type="button" variant="outline" onClick={() => setEdit(null)}>{t("取消")}</Button></div>
        </form> : null}
        {!edit && !filteredFavorites.length ? <p className="field-hint">{t("没有匹配的收藏，可以新建或从输入框保存草稿。")}</p> : null}
        {!edit && filteredFavorites.map((item) => <details key={item.id} name="prompt-manager-preview" className="prompt-tools-record">
          <summary><span className="prompt-tools-record-title">{item.pinned ? `${t("置顶")} · ` : ""}{item.title}</span><small title={item.project?.workingDirectory}>{item.project ? t("项目") : t("全局")}</small><span className="prompt-tools-snippet">{item.body.replace(/\s+/g, " ")}</span></summary>
          <p className="field-hint">{item.tags.join(" · ")}</p><pre>{item.body}</pre>
          <div className="prompt-tools-toolbar"><Button variant="outline" disabled={busy} onClick={() => startEdit(item)}>{t("编辑")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await request("library/save", { ...item, pinned: !item.pinned }); await load(); })}>{item.pinned ? t("取消置顶") : t("置顶")}</Button>
            <Button variant="outline" disabled={busy} onClick={() => void run(() => remove("library", item.id))}>{t("删除")}</Button></div>
        </details>)}
      </> : <>
        <details className="prompt-tools-options"><summary>{t("筛选与导出")}</summary>
        <div className="prompt-tools-toolbar"><Field label={t("评价")}><AppSelect value={rating} onChange={setRating} options={[{ value: "", label: t("全部") }, { value: "useful", label: t("有用") }, { value: "improve", label: t("需改进") }]} /></Field>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await exportFile("feedback", { query, rating }); })}>{t("导出反馈")}</Button></div>
        </details>
        {!feedback.length ? <p className="field-hint">{t("还没有反馈，在增强结果中评价后会保存在这里。")}</p> : null}
        {feedback.map((item) => <details key={item.id} className="prompt-tools-record">
          <summary>{item.rating === "useful" ? t("有用") : t("需改进")} · {new Date(item.createdAt).toLocaleString()} · {item.metadata.model}</summary>
          <p>{item.note}</p><p>{item.metadata.mode} · {item.metadata.scenario}</p>
          <h4>{t("原稿")}</h4><pre>{item.original}</pre><h4>{t("生成结果")}</h4><pre>{item.generated}</pre><h4>{t("编辑后的结果")}</h4><pre>{item.edited}</pre>
          <details><summary>{t("追问答案与规则")}</summary><pre>{JSON.stringify(item.history, null, 2)}</pre><pre>{item.metadata.systemPrompt}</pre></details>
          <Button variant="outline" disabled={busy} onClick={() => void run(() => remove("feedback", item.id))}>{t("删除")}</Button>
        </details>)}
      </>}
    </CardContent>
  </Panel>;
}
