import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Search, Upload, Download, ArrowLeft, Pencil, Trash2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CardContent } from "@/components/ui/card";
import { AppSelect, CardHead, Field, Panel } from "@/components/ui/manager-primitives";
import { t, tf } from "@/i18n";
import "./prompt-tools.css";

type Project = { hostId: string; workingDirectory: string };
type Favorite = {
  id: string; title: string; body: string; tags: string[]; project: Project | null;
  pinned: boolean; order: number;
};
type Result = {
  status: string; message?: string; favorites?: Favorite[]; tags?: string[]; total?: number;
  inserted?: number; skipped?: number; favorite?: Favorite; index?: number;
};
async function request(action: string, payload: unknown = {}): Promise<Result> {
  const result = await invoke<Result>("prompt_tools_request", { action, payload });
  if (result.status !== "ok") throw new Error(result.message || t("读取或保存失败，请重试"));
  return result;
}
const emptyFavorite = (): Favorite => ({ id: "", title: "", body: "", tags: [], project: null, pinned: false, order: 0 });

export function PromptToolsPanel() {
  const [items, setItems] = useState<Favorite[]>([]), [query, setQuery] = useState(""),
    [scope, setScope] = useState("available"), [tag, setTag] = useState(""), [projectFilter, setProjectFilter] = useState(""),
    [tags, setTags] = useState<string[]>([]), [selected, setSelected] = useState<Favorite | null>(null),
    [edit, setEdit] = useState<Favorite | null>(null), [tagsText, setTagsText] = useState(""),
    [error, setError] = useState(""), [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false), [dragging, setDragging] = useState<string | null>(null), [over, setOver] = useState<string | null>(null),
    [importData, setImportData] = useState<{ data: unknown; added: number; skipped: number } | null>(null);
  const revision = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  const projects = [...new Map(items.filter(item => item.project).map(item => [JSON.stringify(item.project), item.project!])).entries()];
  const visibleItems = items.filter(item => !projectFilter || JSON.stringify(item.project) === projectFilter);
  async function load() {
    const token = ++revision.current;
    const result = await request("library/list", { all: true, query, scope, tag });
    if (token === revision.current) {
      setItems(result.favorites || []);
      setTags(result.tags || []);
      setSelected(value => result.favorites?.find(item => item.id === value?.id) || null);
    }
  }
  useEffect(() => { void load().catch(() => setError(t("读取或保存失败，请重试"))); return () => { ++revision.current; }; }, [scope, tag]);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : t("读取或保存失败，请重试")); }
    finally { setBusy(false); }
  }
  function startEdit(item: Favorite) {
    setEdit({ ...item, tags: [...item.tags], project: item.project ? { ...item.project } : null });
    setTagsText(item.tags.join(", ")); setError("");
  }
  async function remove(item: Favorite) {
    await run(async () => {
      const removed = await request("library/delete", { id: item.id });
      await load();
      setMessage(tf("已删除“{0}”", [item.title]));
      if (removed.favorite) {
        setUndo(() => async () => {
          await request("library/restore", { favorite: removed.favorite, index: removed.index || 0 });
          await load(); setMessage(t("已恢复"));
        });
      }
    });
  }
  const [undo, setUndo] = useState<(() => Promise<void>) | null>(null);
  async function move(id: string, target: string) {
    if (id === target) return;
    const next = [...visibleItems];
    const from = next.findIndex(item => item.id === id), to = next.findIndex(item => item.id === target);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const order = [...next.map(item => item.id)];
    setItems(value => {
      const filtered = next.map(item => item.id);
      return [...value].sort((a, b) => {
        const aIndex = filtered.indexOf(a.id), bIndex = filtered.indexOf(b.id);
        if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
        return a.order - b.order;
      });
    });
    await run(async () => { await request("library/reorder", { ids: order }); await load(); });
  }
  return <Panel className="enhance-service-panel prompt-tools-panel">
    <CardHead title={t("常用提示词")} />
    <CardContent className="settings-content">
      <form className="prompt-tools-toolbar" onSubmit={event => { event.preventDefault(); void run(load); }}>
        <Input aria-label={t("搜索")} placeholder={t("搜索标题、正文或标签")} value={query} onChange={event => setQuery(event.currentTarget.value)} />
        <Button type="submit" variant="outline" title={t("搜索")} aria-label={t("搜索")} disabled={busy}><Search size={16} /></Button>
        <Button type="button" title={t("新建")} aria-label={t("新建")} disabled={busy} onClick={() => startEdit(emptyFavorite())}><Plus size={16} /></Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}{undo && <Button variant="ghost" onClick={() => { const action = undo; setUndo(null); void run(action); }}>{t("撤销")}</Button>}</p>}
      <details className="prompt-tools-options" open><summary>{t("筛选与导入导出")}</summary>
        <div className="prompt-tools-toolbar">
          <Field label={t("范围")}><AppSelect value={scope} onChange={setScope} options={[
            { value: "available", label: t("全部") }, { value: "global", label: t("通用") }, { value: "project", label: t("项目") }]} /></Field>
          <Field label={t("标签")}><AppSelect value={tag} onChange={setTag} options={[
            { value: "", label: t("全部标签") }, ...tags.map(value => ({ value, label: value }))]} /></Field>
          <Field label={t("项目筛选")}><AppSelect value={projectFilter} onChange={setProjectFilter} options={[
            { value: "", label: t("全部项目") }, ...projects.map(([value, project]) => ({ value, label: `${project.hostId} · ${project.workingDirectory}` }))]} /></Field>
          <Button variant="outline" disabled={busy} title={t("导入")} aria-label={t("导入")} onClick={() => fileInput.current?.click()}><Upload size={16} /></Button>
          <Button variant="outline" disabled={busy} title={t("导出")} aria-label={t("导出")} onClick={() => void run(async () => {
            const path = await save({ defaultPath: "prompt-favorites.json", filters: [{ name: "JSON", extensions: ["json"] }] });
            if (!path) return;
            const result = await invoke<Result>("prompt_tools_export_file", { kind: "library", path, payload: {} });
            if (result.status !== "ok") throw new Error(result.message);
          })}><Download size={16} /></Button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!file) return;
            void run(async () => {
              if (file.size > 8 * 1024 * 1024) throw new Error(t("文件不能超过 8 MiB"));
              const data: unknown = JSON.parse(await file.text()), result = await request("library/import-preview", data);
              setImportData({ data, added: result.inserted || 0, skipped: result.skipped || 0 });
            });
          }} />
        </div>
      </details>
      {importData && <div className="settings-block">
        <p>{tf("将导入 {0} 条，跳过 {1} 条重复收藏。", [importData.added, importData.skipped])}</p>
        <Button disabled={busy} onClick={() => void run(async () => {
          await request("library/import", importData.data); setImportData(null); await load(); setMessage(t("已导入"));
        })}>{t("导入")}</Button>
        <Button variant="outline" onClick={() => setImportData(null)}>{t("取消")}</Button>
      </div>}
      {edit ? <form className="prompt-tools-editor" onSubmit={event => {
        event.preventDefault(); void run(async () => {
          await request("library/save", { ...edit, tags: tagsText.split(/[,，]/).map(value => value.trim()).filter(Boolean) });
          setEdit(null); await load(); setMessage(t("已保存"));
        });
      }}>
        <Field label={t("标题")}><Input required maxLength={200} value={edit.title} onChange={event => setEdit({ ...edit, title: event.currentTarget.value })} /></Field>
        <Field label={t("内容")}><Textarea required maxLength={20000} rows={12} value={edit.body} onChange={event => setEdit({ ...edit, body: event.currentTarget.value })} /></Field>
        <details><summary>{t("更多选项")}</summary>
          <Field label={t("标签")}><Input value={tagsText} placeholder={t("用逗号分隔")} onChange={event => setTagsText(event.currentTarget.value)} /></Field>
          <Field label={t("范围")}><AppSelect value={edit.project ? "project" : "global"}
            onChange={value => setEdit({ ...edit, project: value === "project" ? edit.project || { hostId: "local", workingDirectory: "" } : null })}
            options={[{ value: "global", label: t("所有项目都能用") }, { value: "project", label: t("仅当前项目") }]} /></Field>
          {edit.project && <>
            <Field label={t("主机")}><Input required value={edit.project.hostId} onChange={event => setEdit({ ...edit, project: { ...edit.project!, hostId: event.currentTarget.value } })} /></Field>
            <Field label={t("项目目录")}><Input required value={edit.project.workingDirectory} onChange={event => setEdit({ ...edit, project: { ...edit.project!, workingDirectory: event.currentTarget.value } })} /></Field>
          </>}
        </details>
        <div className="prompt-tools-toolbar"><Button type="submit" disabled={busy}>{t("保存")}</Button>
          <Button type="button" variant="outline" onClick={() => setEdit(null)}>{t("取消")}</Button></div>
      </form> : <div className="prompt-manager-browser">
        <div className="prompt-manager-list">
          {!visibleItems.length && <p className="field-hint">{t("没有匹配的收藏")}</p>}
          {visibleItems.map(item => <div key={item.id} className="prompt-manager-row"
            data-dragging={dragging === item.id || undefined} data-over={over === item.id && dragging !== item.id || undefined}
            onDragOver={event => { if (!dragging) return; event.preventDefault(); setOver(item.id); }}
            onDragLeave={() => setOver(value => value === item.id ? null : value)}
            onDrop={event => { event.preventDefault(); const id = dragging; setDragging(null); setOver(null); if (id) void move(id, item.id); }}>
            <button type="button" className="prompt-manager-grip" draggable title={t("拖动排序")} aria-label={`${t("拖动排序")}: ${item.title}`}
              onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragging(item.id); }}
              onDragEnd={() => { setDragging(null); setOver(null); }}><GripVertical size={14} /></button>
            <button type="button" className="prompt-manager-item" aria-pressed={selected?.id === item.id} onClick={() => setSelected(item)}>
              <strong>{item.title}</strong>
              <span>{item.tags.length ? `${item.tags.join(" · ")} — ` : ""}{item.body.replace(/\s+/g, " ")}</span>
            </button>
          </div>)}
        </div>
        {selected ? <section className="prompt-manager-preview">
          <Button variant="ghost" className="prompt-manager-back" title={t("返回列表")} aria-label={t("返回列表")} onClick={() => setSelected(null)}><ArrowLeft size={16} /></Button>
          <h3>{selected.title}</h3>
          {selected.project && <p className="field-hint">{selected.project.workingDirectory}</p>}
          <pre>{selected.body}</pre>
          <div className="prompt-tools-toolbar">
            <Button variant="outline" title={t("编辑")} aria-label={t("编辑")} onClick={() => startEdit(selected)}><Pencil size={16} /></Button>
            <Button variant="outline" title={t("删除")} aria-label={t("删除")} disabled={busy} onClick={() => void remove(selected)}><Trash2 size={16} /></Button>
          </div>
        </section> : <p className="field-hint">{t("选择一条收藏查看正文")}</p>}
      </div>}
    </CardContent>
  </Panel>;
}
