import { Download, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type ProviderImportActionsProps = {
  importingCurrentConfig: boolean;
  switching: boolean;
  thirdPartyOpen: boolean;
  canImportCcs: boolean;
  ccsSummary: string;
  onCreateCustom: () => void;
  onImportCurrent: () => void;
  onCreateAggregate: () => void;
  onToggleThirdParty: () => void;
  onImportCcs: () => void;
  onRefreshCcs: () => void;
};

export function ProviderImportActions({
  importingCurrentConfig,
  switching,
  thirdPartyOpen,
  canImportCcs,
  ccsSummary,
  onCreateCustom,
  onImportCurrent,
  onCreateAggregate,
  onToggleThirdParty,
  onImportCcs,
  onRefreshCcs,
}: ProviderImportActionsProps) {
  return (
    <div className="relay-add-row">
      <Button variant="secondary" onClick={onCreateCustom}>
        <Plus className="h-4 w-4" />
        {t("添加自定义供应商")}
      </Button>
      <Button
        variant="secondary"
        disabled={importingCurrentConfig || switching}
        onClick={onImportCurrent}
        title={t("从 Codex 默认目录读取 config.toml 和 auth.json，检查后保存为独立供应商。")}
      >
        <Download className="h-4 w-4" />
        {importingCurrentConfig ? t("正在读取配置…") : t("导入默认 config.toml")}
      </Button>
      <Button variant="secondary" onClick={onCreateAggregate}>
        <Plus className="h-4 w-4" />
        {t("添加聚合供应商")}
      </Button>
      <div className="third-party-import">
        <Button onClick={onToggleThirdParty} variant="secondary">
          <Download className="h-4 w-4" />
          {t("从第三方导入")}
        </Button>
        {thirdPartyOpen ? (
          <div className="third-party-import-menu">
            <button disabled={!canImportCcs} onClick={onImportCcs} type="button">
              <strong>ccswitch</strong>
              <span>{ccsSummary}</span>
            </button>
            <button onClick={onRefreshCcs} type="button">
              <RefreshCw className="h-4 w-4" />
              {t("刷新列表")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
