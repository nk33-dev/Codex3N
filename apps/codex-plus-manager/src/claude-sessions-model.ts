import { sessionGroups } from "./management-model.ts";

export type ClaudeSession = {
  key: string;
  id: string;
  title: string;
  cwd: string;
  createdAtMs: number | null;
  updatedAtMs: number;
  transcriptPath: string;
  fileSize: number;
  desktop: boolean;
  protectedReason: string | null;
  warnings: string[];
};

export type ClaudeSessionPage = {
  sessions: ClaudeSession[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  warnings: string[];
};

export type DeleteOutcome = {
  key: string;
  title: string;
  status: "ok" | "partial" | "failed";
  message: string;
  backupToken: string | null;
};

export function claudeSessionGroups(sessions: ClaudeSession[], mode: "project" | "time") {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  return sessionGroups(sessions.map((session) => ({
    id: session.key, title: session.title, cwd: session.cwd,
    modelProvider: "Claude", archived: false, updatedAtMs: session.updatedAtMs,
    rolloutPath: session.transcriptPath, dbPath: "",
  })), mode).map((group) => ({
    ...group, sessions: group.sessions.map((session) => byKey.get(session.id)!),
  }));
}

export function deletionCounts(outcomes: DeleteOutcome[], total: number) {
  return {
    deleted: outcomes.filter((outcome) => outcome.status === "ok").length,
    failed: outcomes.filter((outcome) => outcome.status !== "ok").length,
    unprocessed: Math.max(0, total - outcomes.length),
  };
}

export function selectableSessionKeys(sessions: ClaudeSession[]) {
  return sessions.filter((session) => !session.protectedReason).map((session) => session.key);
}
