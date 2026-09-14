import { RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export type ProviderEnvConflict = {
  name: string;
  source: string;
};

export function EnvConflictNotice({
  conflicts,
  onRemove,
  onRefresh,
}: {
  conflicts: ProviderEnvConflict[];
  onRemove: (names: string[]) => void;
  onRefresh: () => void;
}) {
  if (!conflicts.length) return null;
  const names = Array.from(new Set(conflicts.map((conflict) => conflict.name))).sort();
  return (
    <div className="env-conflict-notice">
      <div className="env-conflict-icon"><ShieldAlert className="h-4 w-4" /></div>
      <div className="env-conflict-body">
        <strong>{t("检测到 OPENAI 环境变量")}</strong>
        <p>{t("这些变量可能覆盖当前供应商写入的 config.toml / auth.json；CODEX_HOME 不会被清理。")}</p>
        <div className="env-conflict-tags">
          {conflicts.map((conflict) => (
            <span key={`${conflict.source}-${conflict.name}`}>
              {conflict.name}
              <small>{sourceLabel(conflict.source)}</small>
            </span>
          ))}
        </div>
      </div>
      <div className="env-conflict-actions">
        <Button onClick={() => onRemove(names)} size="sm">
          <Trash2 className="h-4 w-4" />
          {t("删除")}
        </Button>
        <Button onClick={onRefresh} size="sm" variant="secondary">
          <RefreshCw className="h-4 w-4" />
          {t("检测")}
        </Button>
      </div>
    </div>
  );
}

function sourceLabel(source: string): string {
  if (source === "process") return t("当前进程");
  if (source === "user") return t("用户环境");
  return source || t("环境变量");
}
