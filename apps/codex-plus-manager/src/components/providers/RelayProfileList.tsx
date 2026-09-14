import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckCircle2, Copy, Edit3, GripVertical, TestTube, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { RelayProfile } from "../../provider-types";
import { providerInitial, relayProtocolLabel, relayModeLabel, isSystemDefaultRelayProfile, relaySub2ApiMultiplierLabel, isAggregateRelayProfile } from "../../provider-utils";

type ProfileCallbacks = {
  onEdit: (id: string) => void;
  onSwitch: (id: string) => void;
  onTest: (profile: RelayProfile) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
};

type ProfileCardProps = ProfileCallbacks & {
  profile: RelayProfile;
  enabled: boolean;
  activeRelayId: string;
  disabled: boolean;
  canRemove: boolean;
  profileBrief: (profile: RelayProfile) => string;
};

type RelayProfileListProps = Omit<ProfileCardProps, "profile" | "canRemove"> & {
  profiles: RelayProfile[];
  onReorder: (sourceId: string, targetId: string) => void;
};

export function RelayProfileList({ profiles, onReorder, ...cardProps }: RelayProfileListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(String(active.id), String(over.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
        <div className="relay-profile-list">
          {profiles.map((profile) => (
            <SortableRelayProfileCard
              key={profile.id}
              {...cardProps}
              profile={profile}
              canRemove={profiles.length > 1}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRelayProfileCard({
  profile, enabled, activeRelayId, disabled, canRemove, profileBrief,
  onEdit, onSwitch, onTest, onDuplicate, onRemove,
}: ProfileCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: profile.id });
  const active = enabled
    ? profile.id === activeRelayId
    : isSystemDefaultRelayProfile(profile);
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      className={`relay-profile-card ${active ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      data-relay-profile-id={profile.id}
      key={profile.id}
      onKeyDown={(event) => {
        if (event.key === "Enter") onEdit(profile.id);
      }}
      ref={setNodeRef}
      style={style}
      tabIndex={0}
    >
      <button
        aria-label={t("拖动排序")}
        className="relay-drag"
        title={t("拖动排序")}
        type="button"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="relay-index" title={profile.name || t("未命名供应商")}>
        {providerInitial(profile.name)}
      </span>
      <span className="relay-summary">
        <strong>{profile.name || t("未命名供应商")}</strong>
        <small>{relayModeLabel(profile.relayMode)} · {relayProtocolLabel(profile.protocol)} · {profileBrief(profile)}</small>
        {profile.sub2apiEnabled ? (
          <small className="relay-sub2api-rate">{relaySub2ApiMultiplierLabel(profile)}</small>
        ) : null}
      </span>
      <span className="relay-card-actions">
        <Button
          className={`relay-use-button ${active ? "active" : ""}`}
          disabled={disabled || (!enabled && isSystemDefaultRelayProfile(profile))}
          onClick={(event) => {
            event.stopPropagation();
            if (disabled || (!enabled && isSystemDefaultRelayProfile(profile))) return;
            onSwitch(profile.id);
          }}
          size="sm"
          title={disabled ? t("供应商切换不可用") : active ? t("当前正在使用") : t("设为当前")}
          variant={active ? "secondary" : "outline"}
        >
          <CheckCircle2 className="h-4 w-4" />
          {active ? t("使用中") : t("使用")}
        </Button>
        <span className="relay-card-extra">
          <Button
            disabled={isAggregateRelayProfile(profile)}
            onClick={(event) => {
              event.stopPropagation();
              if (isAggregateRelayProfile(profile)) return;
              onTest(profile);
            }}
            size="icon"
            title={isAggregateRelayProfile(profile) ? t("聚合供应商会在真实对话中轮转成员，请测试成员供应商") : t("发送 hi 测试")}
            variant="ghost"
          >
            <TestTube className="h-4 w-4" />
          </Button>
          <Button
            onClick={(event) => {
              event.stopPropagation();
              onEdit(profile.id);
            }}
            size="icon"
            title={t("编辑")}
            variant="ghost"
          >
            <Edit3 className="h-4 w-4" />
          </Button>
          <Button
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate(profile.id);
            }}
            size="icon"
            title={t("复制")}
            variant="ghost"
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            disabled={!canRemove}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(profile.id);
            }}
            size="icon"
            title={t("删除供应商")}
            variant="ghost"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </span>
      </span>
    </div>
  );
}

