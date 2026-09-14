
  const invalidSessionStorageKey = "codex3n.hiddenInvalidSessions.v1";
  let invalidSessionIds = new Set();
  let verifiedInvalidSessionIds = new Set();
  let sessionHealthBusy = false;
  let sessionHealthGeneration = 0;
  let sessionHealthCheckedAt = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(invalidSessionStorageKey) || "[]");
    if (Array.isArray(saved)) invalidSessionIds = new Set(saved.map(normalizedCodexThreadUuid).filter(Boolean));
  } catch {}

  function updateSessionHealthStatus(message) {
    document.querySelectorAll("[data-codex-session-health-status]").forEach((node) => { node.textContent = message; });
    document.querySelectorAll("[data-codex-session-health-scan]").forEach((button) => { button.disabled = sessionHealthBusy; });
  }

  function localSessionHealthRowId(row) {
    const hostId = row.getAttribute("data-app-action-sidebar-thread-host-id");
    const ref = sessionRefFromRow(row);
    // 主机归属不明的旧版行、云端聊天和 SSH 会话都不能套用本机文件检查结果。
    if (hostId !== "local" && !(hostId == null && /^local:/i.test(ref.session_id))) return "";
    return normalizedCodexThreadUuid(ref.session_id).toLowerCase();
  }

  function applyInvalidSessionVisibility() {
    sessionRows().forEach((row) => {
      const id = localSessionHealthRowId(row);
      const hidden = codexPlusBackendSettings.enhancementsEnabled !== false && !!id && verifiedInvalidSessionIds.has(id);
      const marker = row.getAttribute("data-codex-invalid-session-hidden");
      if (hidden && marker !== "true") row.setAttribute("data-codex-invalid-session-hidden", "true");
      else if (!hidden && marker !== null) row.removeAttribute("data-codex-invalid-session-hidden");
    });
  }

  function resetInvalidSessionVisibility() {
    try {
      localStorage.removeItem(invalidSessionStorageKey);
      sessionHealthGeneration += 1;
      invalidSessionIds.clear();
      verifiedInvalidSessionIds.clear();
      applyInvalidSessionVisibility();
      updateSessionHealthStatus("已显示全部会话；会话数据未改动。");
    } catch (error) {
      updateSessionHealthStatus(`无法保存显示设置：${error?.message || String(error)}`);
    }
  }

  async function sessionHealthRequest(request, timeoutMs = 5000) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("检查超时")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function nativeSessionIsMissing(threadId, clients) {
    if (!clients.length) return false;
    if (threadId[14] === "7" && Date.now() - uuidV7TimestampMs(threadId) < 3600000) return false;
    let missing = false;
    let uncertain = false;
    for (const client of clients) {
      try {
        const result = await sessionHealthRequest(() => client.sendRequest("thread/read", { threadId, includeTurns: true }));
        if (result?.thread?.id === threadId || result?.result?.thread?.id === threadId) return false;
        uncertain = true;
      } catch (error) {
        const message = String(error?.message || error).trim().toLowerCase();
        // 模块发现可能同时返回 IPC 客户端；不支持此方法的客户端不参与会话判断。
        if (error?.code === -32601 || /^(?:unknown method|method not found)(?::? thread\/read)?$/.test(message)) continue;
        // 新版 thread/read 在持久记录和内存会话都不存在时返回 thread not loaded。
        const missingMessages = [`no rollout found for thread id ${threadId.toLowerCase()}`, `thread not loaded: ${threadId.toLowerCase()}`];
        if (missingMessages.some((expected) => message === expected || message.endsWith(`: ${expected}`))) missing = true;
        else uncertain = true;
      }
    }
    // 支持读取的客户端只要有一个无法确认，就保留该会话。网络/权限错误不构成失效证据。
    return missing && !uncertain;
  }

  async function checkAndHideInvalidSessions(automatic = false) {
    if (sessionHealthBusy) return;
    sessionHealthBusy = true;
    const generation = sessionHealthGeneration;
    if (!automatic) updateSessionHealthStatus("正在检查会话文件和恢复备份…");
    try {
      const observedIds = automatic ? [...invalidSessionIds] : sessionRows(true).map(localSessionHealthRowId).filter(Boolean);
      const result = await sessionHealthRequest(() => postJson("/session/health", { threadIds: observedIds }), 60000);
      if (result.status !== "ok" || !Array.isArray(result.missingIds)) throw new Error(result.message || "检查失效会话失败");
      const missingIds = result.missingIds.filter((id) => !automatic || invalidSessionIds.has(id));
      const clients = missingIds.length ? (await sessionHealthRequest(loadAppServerRequestCandidates)).candidates.filter((client) => typeof client?.sendRequest === "function") : [];
      if (missingIds.length && !clients.length) throw new Error("无法连接 Codex 会话读取接口，请重启后再试");
      const confirmed = new Set();
      for (const [index, id] of missingIds.entries()) {
        if (generation !== sessionHealthGeneration) return;
        if (!automatic) updateSessionHealthStatus(`正在确认失效会话 ${index + 1}/${missingIds.length}…`);
        if (await nativeSessionIsMissing(id, clients)) confirmed.add(id);
      }
      // 读取原生接口期间可能发生撤销删除或恢复；隐藏前重新检查恢复来源。
      if (confirmed.size) {
        const latest = await sessionHealthRequest(() => postJson("/session/health", { threadIds: [...confirmed] }), 60000);
        if (latest.status !== "ok" || !Array.isArray(latest.missingIds)) throw new Error(latest.message || "无法复核恢复来源");
        const stillMissing = new Set(latest.missingIds);
        for (const id of confirmed) if (!stillMissing.has(id)) confirmed.delete(id);
      }
      if (generation !== sessionHealthGeneration) return;
      localStorage.setItem(invalidSessionStorageKey, JSON.stringify([...confirmed]));
      invalidSessionIds = confirmed;
      verifiedInvalidSessionIds = new Set(confirmed);
      applyInvalidSessionVisibility();
      if (!automatic) updateSessionHealthStatus(`已检查 ${result.scanned} 条会话记录，确认失效并隐藏 ${confirmed.size} 个。可恢复或无法确认的会话已保留。`);
    } catch (error) {
      if (generation !== sessionHealthGeneration) return;
      verifiedInvalidSessionIds.clear();
      applyInvalidSessionVisibility();
      if (!automatic) updateSessionHealthStatus(`未隐藏会话：${error?.message || String(error)}`);
    } finally {
      sessionHealthBusy = false;
      sessionHealthCheckedAt = Date.now();
      document.querySelectorAll("[data-codex-session-health-scan]").forEach((button) => { button.disabled = false; });
    }
  }

  function refreshInvalidSessionVisibility() {
    applyInvalidSessionVisibility();
    if (invalidSessionIds.size && !sessionHealthBusy && Date.now() - sessionHealthCheckedAt > 60000
        && codexPlusBackendSettingsLoaded && codexPlusBackendSettings.enhancementsEnabled !== false) {
      void checkAndHideInvalidSessions(true);
    }
  }

