import { ChevronDown, Copy, ExternalLink, KeyRound, MessageCircle, PackageOpen, Play, PowerOff, Save, ScanLine, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge as UiBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Panel, formatTime } from "@/components/ui/manager-primitives";
import { t } from "@/i18n";

import type { LocalSession, WeixinConnectStatusResult, WeixinQrResult } from "../App";
import type { BackendSettings } from "../provider-types";

export function SearchablePathPicker({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const filteredOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    return options.filter((option) => !query || option.toLowerCase().includes(query)).slice(0, 30);
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div className="weixin-search-picker" ref={rootRef}>
      <div className="weixin-search-input-wrap">
        <Search className="weixin-search-input-icon h-4 w-4" />
        <Input
          aria-expanded={open}
          aria-label={placeholder}
          className="h-10"
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder={placeholder}
          value={value}
        />
        <ChevronDown className={`weixin-search-input-chevron h-4 w-4${open ? " is-open" : ""}`} />
      </div>
      {open ? (
        <div className="weixin-search-menu" role="listbox">
          {filteredOptions.length ? filteredOptions.map((option) => (
            <button
              className="weixin-search-option"
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              type="button"
            >
              <span>{option}</span>
            </button>
          )) : (
            <div className="weixin-search-empty">{t("没有匹配的已有目录，可继续直接输入。")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SearchableSessionPicker({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: LocalSession[];
  selectedId: string;
  onSelect: (session: LocalSession | null) => void;
}) {
  const selected = sessions.find((session) => session.id === selectedId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sessions
      .filter((session) => !normalized || [session.title, session.cwd, session.id, session.modelProvider].some((value) => value.toLowerCase().includes(normalized)))
      .slice(0, 30);
  }, [query, sessions]);

  useEffect(() => {
    if (selected) setQuery(selected.title || selected.id);
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div className="weixin-search-picker" ref={rootRef}>
      <div className="weixin-search-input-wrap">
        <Search className="weixin-search-input-icon h-4 w-4" />
        <Input
          aria-expanded={open}
          aria-label={t("已有会话")}
          className="h-10"
          onChange={(event) => {
            setQuery(event.target.value);
            if (selectedId) onSelect(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder={sessions.length ? t("搜索已有会话") : t("暂无可用的本地会话")}
          value={query}
        />
        <ChevronDown className={`weixin-search-input-chevron h-4 w-4${open ? " is-open" : ""}`} />
      </div>
      {open ? (
        <div className="weixin-search-menu weixin-session-menu" role="listbox">
          {filteredSessions.length ? filteredSessions.map((session) => (
            <button
              aria-selected={session.id === selectedId}
              className="weixin-search-option weixin-session-option"
              key={session.id}
              onClick={() => {
                onSelect(session);
                setQuery(session.title || session.id);
                setOpen(false);
              }}
              type="button"
            >
              <strong>{session.title || t("未命名会话")}</strong>
              <span>{session.cwd || t("未记录项目路径")}</span>
              <small>{formatTime(session.updatedAtMs ?? 0)} · {session.modelProvider || t("provider 未记录")}</small>
            </button>
          )) : (
            <div className="weixin-search-empty">{t("没有匹配的本地会话。")}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function WeixinConnectScreen({
  form,
  status,
  qr,
  sessions,
  onFormChange,
  onSave,
  onQrLogin,
  onStart,
  onStop,
  onChooseWorkDir,
  onChooseCodexPath,
  onUseDesktopCodexCli,
  onOpenQr,
  onCopyQr,
}: {
  form: BackendSettings;
  status: WeixinConnectStatusResult | null;
  qr: WeixinQrResult | null;
  sessions: LocalSession[];
  onFormChange: (value: BackendSettings) => void;
  onSave: () => void;
  onQrLogin: () => void;
  onStart: () => void;
  onStop: () => void;
  onChooseWorkDir: () => void;
  onChooseCodexPath: () => void;
  onUseDesktopCodexCli: () => void;
  onOpenQr: (url: string) => void;
  onCopyQr: (url: string) => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const workDirOptions = useMemo(
    () => Array.from(new Set(sessions.map((session) => session.cwd.trim()).filter(Boolean))).sort(),
    [sessions],
  );
  const runtimeState = status?.state ?? "stopped";
  const running = ["starting", "running", "retrying"].includes(runtimeState);
  const stopping = runtimeState === "stopping";
  const statusLabel = {
    starting: t("正在启动"),
    running: t("运行中"),
    retrying: t("正在重试"),
    stopping: t("正在停止"),
    error: t("异常"),
    stopped: t("已停止"),
  }[runtimeState] ?? runtimeState;

  return (
    <div className="weixin-connect-page">
      <Panel className={`weixin-status-panel is-${runtimeState}`}>
        <CardContent className="weixin-status-content">
          <div className="weixin-connect-head">
            <div className="weixin-status-primary">
              <div className="weixin-status-icon" aria-hidden="true">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div>
                <div className="section-heading-row">
                  <h2>{t("个人微信连接")}</h2>
                  <UiBadge variant={runtimeState === "running" ? "default" : runtimeState === "error" ? "outline" : "secondary"}>
                    {statusLabel}
                  </UiBadge>
                </div>
                <p className="muted">{status?.message ?? t("微信连接未启动。")}</p>
              </div>
            </div>
            <div className="toolbar weixin-connect-actions">
              <Button onClick={onSave} variant="outline">
                <Save className="h-4 w-4" />
                {t("保存")}
              </Button>
              <Button onClick={onQrLogin} variant="outline">
                <ScanLine className="h-4 w-4" />
                {form.weixinConnectToken ? t("重新登录") : t("扫码登录")}
              </Button>
              {running || stopping ? (
                <Button disabled={stopping} onClick={onStop} variant="outline">
                  <PowerOff className="h-4 w-4" />
                  {stopping ? t("正在停止") : t("停止")}
                </Button>
              ) : (
                <Button disabled={!form.weixinConnectToken} onClick={onStart}>
                  <Play className="h-4 w-4" />
                  {t("启动")}
                </Button>
              )}
            </div>
          </div>
          <div className="weixin-runtime-meta">
            <div>
              <span>{t("账号")}</span>
              <code title={status?.accountId || form.weixinConnectAccountId || t("未登录")}>
                {status?.accountId || form.weixinConnectAccountId || t("未登录")}
              </code>
            </div>
            <div>
              <span>{t("已处理消息")}</span>
              <strong>{status?.processedMessages ?? 0}</strong>
            </div>
            <div>
              <span>{t("最近联系人")}</span>
              <code title={status?.lastPeerId || t("暂无")}>{status?.lastPeerId || t("暂无")}</code>
            </div>
          </div>
        </CardContent>
      </Panel>

      {qr?.qrContent ? (
        <Panel>
          <CardHeader>
            <CardTitle>{qr.qrStatus === "expired" ? t("二维码已过期，请重新扫码") : qr.qrStatus === "scaned" ? t("已扫码，请在手机上确认") : t("微信扫码登录")}</CardTitle>
            <CardDescription>{t("在手机微信中打开登录链接，或复制到可生成二维码的设备完成确认。")}</CardDescription>
          </CardHeader>
          <CardContent>
            {qr.qrSvg ? (
              <img className="weixin-qr-image" src={`data:image/svg+xml,${encodeURIComponent(qr.qrSvg)}`} alt={t("微信扫码登录")} />
            ) : null}
            <div className="weixin-qr-content">{qr.qrContent}</div>
            <div className="toolbar">
              <Button onClick={() => onOpenQr(qr.qrContent)}>
                <ExternalLink className="h-4 w-4" />
                {t("打开登录链接")}
              </Button>
              <Button onClick={() => onCopyQr(qr.qrContent)} variant="outline">
                <Copy className="h-4 w-4" />
                {t("复制链接")}
              </Button>
            </div>
          </CardContent>
        </Panel>
      ) : null}

      <Panel className="weixin-settings-panel">
        <CardHeader className="weixin-settings-head">
          <div>
            <CardTitle>{t("连接设置")}</CardTitle>
            <CardDescription>{t("每个微信联系人会映射到独立的 Codex 会话。")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="weixin-connect-form">
          <section className="weixin-form-section">
            <div className="weixin-form-section-title">
              <KeyRound className="h-4 w-4" />
              <strong>{t("账号")}</strong>
            </div>
            <div className="weixin-form-fields">
              <label className="field">
                <span>{t("iLink API 地址")}</span>
                <Input
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectBaseUrl: event.target.value })}
                  value={form.weixinConnectBaseUrl}
                />
              </label>
              <label className="field">
                <span>{t("登录凭据")}</span>
                <Input
                  autoComplete="off"
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectToken: event.target.value })}
                  placeholder={t("扫码后自动保存，也可粘贴已有 Bearer token")}
                  type="password"
                  value={form.weixinConnectToken}
                />
              </label>
              <label className="field">
                <span>{t("允许的微信用户 ID")}</span>
                <Input
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectAllowFrom: event.target.value })}
                  placeholder="user@im.wechat"
                  value={form.weixinConnectAllowFrom}
                />
              </label>
              <label className="field">
                <span>{t("账号标识")}</span>
                <Input
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectAccountId: event.target.value })}
                  placeholder={t("扫码后自动填写")}
                  value={form.weixinConnectAccountId}
                />
              </label>
              <label className="field">
                <span>{t("SKRouteTag")}</span>
                <Input
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectRouteTag: event.target.value })}
                  placeholder={t("仅在网关要求时填写")}
                  value={form.weixinConnectRouteTag}
                />
              </label>
            </div>
          </section>

          <section className="weixin-form-section">
            <div className="weixin-form-section-title">
              <MessageCircle className="h-4 w-4" />
              <strong>{t("会话管理")}</strong>
            </div>
            <div className="weixin-form-fields">
              <label className="field">
                <span>{t("工作目录")}</span>
                <div className="weixin-path-row">
                  <SearchablePathPicker
                    onChange={(value) => {
                      setSelectedSessionId("");
                      onFormChange({ ...form, weixinConnectWorkDir: value });
                    }}
                    options={workDirOptions}
                    placeholder={t("搜索或输入工作目录")}
                    value={form.weixinConnectWorkDir}
                  />
                  <Button onClick={onChooseWorkDir} size="icon" title={t("选择工作目录")} type="button" variant="outline">
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </label>
              <label className="field">
                <span>{t("已有会话")}</span>
                <SearchableSessionPicker
                  onSelect={(session) => {
                    setSelectedSessionId(session?.id ?? "");
                    if (session?.cwd) onFormChange({ ...form, weixinConnectWorkDir: session.cwd });
                  }}
                  selectedId={selectedSessionId}
                  sessions={sessions}
                />
                <small className="weixin-field-hint">{t("选择后自动带入该会话的工作目录，微信联系人仍保持独立会话。")}</small>
              </label>
              <label className="field">
                <span>{t("模型")}</span>
                <Input
                  className="h-10"
                  onChange={(event) => onFormChange({ ...form, weixinConnectModel: event.target.value })}
                  placeholder={t("留空时使用 Codex 当前默认模型")}
                  value={form.weixinConnectModel}
                />
              </label>
              <label className="field">
                <span>{t("沙箱权限")}</span>
                <select
                  className="field-select"
                  onChange={(event) => onFormChange({
                    ...form,
                    weixinConnectSandbox: event.target.value as BackendSettings["weixinConnectSandbox"],
                  })}
                  value={form.weixinConnectSandbox}
                >
                  <option value="read-only">{t("只读")}</option>
                  <option value="workspace-write">{t("允许修改工作目录")}</option>
                  <option value="danger-full-access">{t("完全访问")}</option>
                </select>
              </label>
            </div>
          </section>

          <section className="weixin-form-section">
            <div className="weixin-form-section-title">
              <Settings className="h-4 w-4" />
              <strong>Codex CLI</strong>
            </div>
            <div className="weixin-form-fields">
              <label className="field">
                <span>{t("Codex CLI 路径")}</span>
                <div className="weixin-path-row weixin-cli-path-row">
                  <Input
                    className="h-10"
                    onChange={(event) => onFormChange({ ...form, weixinConnectCodexPath: event.target.value })}
                    placeholder={t("留空时从 PATH 查找 codex")}
                    value={form.weixinConnectCodexPath}
                  />
                  <Button
                    className="weixin-bundled-cli-button"
                    onClick={onUseDesktopCodexCli}
                    size="sm"
                    title={t("使用桌面版内置 CLI")}
                    type="button"
                    variant="secondary"
                  >
                    <PackageOpen className="h-4 w-4" />
                    {t("使用桌面版内置 CLI")}
                  </Button>
                  <Button onClick={onChooseCodexPath} size="icon" title={t("选择 Codex CLI")} type="button" variant="outline">
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </label>
            </div>
          </section>
        </CardContent>
      </Panel>
    </div>
  );
}
