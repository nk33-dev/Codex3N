import { invoke } from "@tauri-apps/api/core";
import { Blocks, Play, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CardHead, ConfirmDialog, Field, Panel } from "@/components/ui/manager-primitives";
import { Textarea } from "@/components/ui/textarea";
import { t, tf } from "@/i18n";
import { defaultSettings } from "../lib/default-settings";

import type { CommandResult, SettingsResult, Status } from "../App";
import type { BackendSettings, RelayProfile } from "../provider-types";

type GrokProvidersResult = CommandResult<{
  profiles: RelayProfile[];
  activeRelayId: string;
  live: {
    grokHome: string;
    configPath: string;
    configExists: boolean;
    cliPath: string | null;
    cliInstalled: boolean;
    revision: string;
    defaultModel: string;
    modelsBaseUrl: string;
    models: Array<{ alias: string; model: string; baseUrl: string; contextWindow: number | null; apiKeyConfigured: boolean }>;
  };
  liveProfile: RelayProfile;
}>;

function newGrokProfileDraft(): RelayProfile {
  return {
    ...defaultSettings.relayProfiles[0],
    id: `grok-${Date.now().toString(36)}`,
    name: t("新建 Grok 供应商"),
    modelList: "",
    upstreamBaseUrl: "",
    baseUrl: "",
    apiKey: "",
    protocol: "chatCompletions",
    relayMode: "pureApi",
    configContents: "",
    authContents: "",
  };
}

/**
 * Grok 分区的供应商管理。
 *
 * 映射约定是「一个供应商 = 一个 base_url」：应用到 Grok 时，这个供应商的模型
 * 列表会整体替换 `~/.grok/config.toml` 里所有受管的 `[model.*]` 表，未管理字段
 * （`[ui]`、`[models].web_search` 等）保留。所以「应用到 Grok」是需要确认的
 * 破坏性操作，这里显式二次确认。
 */

export function GrokScreen({
  settings,
  form,
  actions,
}: {
  settings: SettingsResult | null;
  form: BackendSettings;
  actions: {
    saveSettingsValue: (next: BackendSettings, silent?: boolean) => Promise<BackendSettings | null>;
    showMessage: (title: string, message: string, status?: Status) => Promise<void>;
    refreshCurrent: () => void;
  };
}) {
  const [result, setResult] = useState<GrokProvidersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 编辑区走本地草稿 + 显式保存，跟 Codex 供应商页一致。
  // 直接在 onChange 里写盘的话，敲一个 Base URL 会触发几十次全量 save_settings。
  const [draft, setDraft] = useState<RelayProfile | null>(null);

  const shard = form.tools?.grok;
  const profiles = shard?.relayProfiles?.length ? shard.relayProfiles : [];
  const activeId = shard?.activeRelayId || "";
  const activeProfile = profiles.find((profile) => profile.id === activeId);

  // 切换选中的供应商（或外部刷新）时，把草稿重置成磁盘上的值。
  useEffect(() => {
    setDraft(activeProfile ? { ...activeProfile } : null);
    // 只在选中的供应商变化时重置，不要在每次 profiles 数组变化时打断编辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, activeProfile?.name, activeProfile?.upstreamBaseUrl, activeProfile?.apiKey, activeProfile?.modelList]);

  const draftDirty = Boolean(
    draft
      && activeProfile
      && (draft.name !== activeProfile.name
        || draft.upstreamBaseUrl !== activeProfile.upstreamBaseUrl
        || draft.apiKey !== activeProfile.apiKey
        || draft.modelList !== activeProfile.modelList),
  );

  const refresh = async () => {
    setLoading(true);
    try {
      const loaded = await invoke<GrokProvidersResult>("load_grok_providers");
      setResult(loaded);
    } catch (error) {
      await actions.showMessage(t("调用失败"), String(error), "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // 只在进入本页时拉一次；后续状态由本页自己的操作维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// 唯一真正落盘的地方。结构性操作（新增/删除/切换选中）用它，
  /// 编辑区则攒够了再调一次。
  const writeShard = async (
    nextProfiles: RelayProfile[],
    nextActiveId: string,
  ): Promise<boolean> => {
    const next: BackendSettings = {
      ...form,
      activeTool: "grok",
      tools: {
        ...form.tools,
        grok: {
          ...shard,
          relayProfiles: nextProfiles,
          activeRelayId: nextActiveId,
        },
      },
    };
    // saveSettingsValue 会把结果写回 settings / settingsForm，所以这里不需要
    // 自己先 setState（那反而会跟服务端归一化后的结果打架）。
    const saved = await actions.saveSettingsValue(next, true);
    if (!saved) return false;
    await refresh();
    return true;
  };

  const addProfile = async () => {
    const fresh = newGrokProfileDraft();
    const ok = await writeShard([...profiles, fresh], fresh.id);
    if (!ok) return;
    // 新增后直接把草稿铺好，用户马上就能填。
    setDraft({ ...fresh });
    await actions.showMessage(t("已新增"), tf("已新增供应商「{0}」，填好模型列表后点「应用到 Grok」。", [fresh.name]), "ok");
  };

  const saveDraft = async () => {
    if (!draft || !activeProfile || saving) return;
    setSaving(true);
    try {
      const ok = await writeShard(
        profiles.map((profile) => (profile.id === draft.id ? { ...profile, ...draft } : profile)),
        activeId,
      );
      if (ok) await actions.showMessage(t("已保存"), tf("供应商「{0}」已保存。", [draft.name]), "ok");
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async (id: string) => {
    const rest = profiles.filter((profile) => profile.id !== id);
    await writeShard(rest, activeId === id ? (rest[0]?.id ?? "") : activeId);
  };

  const selectProfile = async (id: string) => {
    if (id === activeId) return;
    await writeShard(profiles, id);
  };

  const applyToGrok = async () => {
    if (draftDirty) {
      await actions.showMessage(t("有未保存修改"), t("请先保存当前供应商，再应用到 Grok。"), "failed");
      setConfirming(false);
      return;
    }
    setApplying(true);
    try {
      // 只把 Grok 分片交给后端，避免整份 settings 被当成「本次改动」写回去。
      const applied = await invoke<GrokProvidersResult>("apply_grok_relay_profile", {
        settings: {
          ...form,
          tools: { ...form.tools, grok: { ...shard, activeRelayId: activeId } },
        },
      });
      setConfirming(false);
      if (applied.status === "ok") {
        await actions.showMessage(t("已应用"), applied.message, "ok");
      } else {
        await actions.showMessage(t("应用失败"), applied.message, "failed");
      }
      await refresh();
    } catch (error) {
      await actions.showMessage(t("调用失败"), String(error), "failed");
    } finally {
      setApplying(false);
    }
  };

  const live = result?.live;

  return (
    <>
      <Panel className="grok-panel">
        <CardHead
          title={t("Grok 供应商")}
          detail={t("每个供应商对应一套 Base URL + API Key + 模型列表。")}
        />
        <CardContent>
          <div className="toolbar">
            <Button disabled={loading} onClick={() => void refresh()} variant="outline">
              <RefreshCw className="h-4 w-4" />
              {loading ? t("刷新中") : t("刷新")}
            </Button>
            <Button onClick={() => void addProfile()} variant="outline">
              <Plus className="h-4 w-4" />
              {t("新增供应商")}
            </Button>
            <Button
              disabled={saving || !draftDirty}
              onClick={() => void saveDraft()}
              title={draftDirty ? undefined : t("没有需要保存的修改")}
              variant="outline"
            >
              <Save className="h-4 w-4" />
              {saving ? t("保存中") : t("保存此供应商")}
            </Button>
            <Button
              disabled={!activeProfile || applying || draftDirty}
              onClick={() => setConfirming(true)}
              title={
                !activeProfile
                  ? t("请先选择一个供应商")
                  : draftDirty
                    ? t("请先保存当前修改")
                    : undefined
              }
            >
              <Play className="h-4 w-4" />
              {applying ? t("应用中") : t("应用到 Grok")}
            </Button>
          </div>

          {profiles.length === 0 ? (
            <div className="grok-empty">
              <Blocks className="h-5 w-5" aria-hidden="true" />
              <div>
                <strong>{t("还没有 Grok 供应商")}</strong>
                <span>{t("点「新增供应商」，填好 Base URL、API Key 和模型列表，再点「应用到 Grok」。")}</span>
              </div>
            </div>
          ) : (
            <div className="grok-provider-list">
              {profiles.map((profile) => {
                const selected = profile.id === activeId;
                const modelCount = profile.modelList.split(/[\r\n,]+/).filter((line) => line.trim()).length;
                const endpoint = profile.upstreamBaseUrl || profile.baseUrl;
                return (
                  <div className={`grok-provider-row ${selected ? "active" : ""}`} key={profile.id}>
                    <button
                      className="grok-provider-pick"
                      onClick={() => void selectProfile(profile.id)}
                      type="button"
                    >
                      <span className="grok-provider-name">
                        {profile.name}
                        {selected ? <span className="grok-provider-badge">{t("使用中")}</span> : null}
                      </span>
                      <span className="grok-provider-url">
                        {endpoint || t("未填写 Base URL")}
                      </span>
                    </button>
                    <span className="grok-provider-models">{tf("{0} 个模型", [String(modelCount)])}</span>
                    <Button
                      onClick={() => void removeProfile(profile.id)}
                      size="icon"
                      title={t("删除供应商")}
                      variant="outline"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Panel>

      {draft ? (
        <Panel className="grok-panel">
          <CardHead title={t("编辑供应商")} detail={draft.name} />
          <CardContent>
            <div className="grok-provider-editor">
              <Field label={t("名称")}>
                <Input
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                  value={draft.name}
                />
              </Field>
              <Field label="Base URL">
                <Input
                  onChange={(event) => setDraft({ ...draft, upstreamBaseUrl: event.currentTarget.value })}
                  placeholder="https://your-endpoint.example/v1"
                  value={draft.upstreamBaseUrl}
                />
              </Field>
              <Field label="API Key">
                <Input
                  onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })}
                  placeholder={t("留空则不改动 Grok 里已有的 Key")}
                  type="password"
                  value={draft.apiKey}
                />
              </Field>
              <Field label={t("模型列表")}>
                <Textarea
                  onChange={(event) => setDraft({ ...draft, modelList: event.currentTarget.value })}
                  placeholder={"grok-4.5[1M]\ngrok-4.1-fast"}
                  rows={4}
                  value={draft.modelList}
                />
              </Field>
            </div>
            <p className="muted-line">
              {t("每行一个模型，可用 [1M] / [200K] 后缀声明上下文窗口。")}
              {" "}
              {t("改完点「保存此供应商」，再点「应用到 Grok」生效。")}
            </p>
          </CardContent>
        </Panel>
      ) : null}

      <Panel className="grok-panel">
        <CardHead title={t("Grok 当前配置")} detail={live?.configPath || t("读取 ~/.grok/config.toml")} />
        <CardContent>
          {live ? (
            <div className="grok-live-grid">
              <div className="grok-live-item">
                <span className="grok-live-label">{t("CLI")}</span>
                <span className="grok-live-value">{live.cliPath || t("未检测到")}</span>
              </div>
              <div className="grok-live-item">
                <span className="grok-live-label">{t("默认模型")}</span>
                <span className="grok-live-value">{live.defaultModel || t("未设置")}</span>
              </div>
              <div className="grok-live-item">
                <span className="grok-live-label">{t("全局端点")}</span>
                <span className="grok-live-value">{live.modelsBaseUrl || t("未设置")}</span>
              </div>
              <div className="grok-live-item">
                <span className="grok-live-label">{t("受管模型")}</span>
                <span className="grok-live-value">
                  {live.models.length ? live.models.map((model) => model.alias).join("、") : t("无")}
                </span>
              </div>
            </div>
          ) : (
            <p className="muted-line">{t("尚未读取。")}</p>
          )}
        </CardContent>
      </Panel>

      {confirming ? (
        <ConfirmDialog
          confirm={{            title: t("应用到 Grok？"),
            message: tf(
              "Grok 里所有由 Codex++ 管理的模型表会被供应商「{0}」的模型列表整体替换（[ui]、web_search 等未管理字段保留）。原配置会先备份。",
              [activeProfile?.name || ""],
            ),
            confirmText: applying ? t("应用中") : t("确认应用"),
            cancelText: t("取消"),
          }}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void applyToGrok()}
        />
      ) : null}
    </>
  );
}
