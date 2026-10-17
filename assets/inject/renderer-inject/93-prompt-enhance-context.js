  // 只沿当前输入框的已挂载祖先读取元数据，不用全局最近项目兜底。
  function codexPlusPromptEnhanceLocation(editor, composerId = "") {
    const records = [], scopes = [], visited = new Set();
    for (let dom = editor, depth = 0; dom && depth < 24; dom = dom.parentElement, depth += 1) {
      const key = Object.getOwnPropertyNames(dom).find((name) => name.startsWith("__reactFiber$"));
      for (let fiber = key ? dom[key] : null, hops = 0; fiber && hops < 32 && !visited.has(fiber); fiber = fiber.return, hops += 1) {
        visited.add(fiber);
        const props = fiber.memoizedProps;
        if (props) records.push(props);
        for (let hook = fiber.memoizedState, index = 0; hook && index < 64; hook = hook.next, index += 1) {
          const scope = hook.memoizedState?.current;
          if (scope && typeof scope.get === "function" && scope.value?.routeKind) scopes.push(scope);
        }
      }
    }
    const route = scopes.find((scope) => ["local-thread", "client-local-thread", "home", "new-thread-panel"].includes(scope.value.routeKind));
    const routeId = route?.value?.conversationId || route?.value?.clientThreadId || "";
    const identity = (record) => record?.conversationId || record?.clientThreadId || record?.threadId || record?.id || "";
    const expanded = records.flatMap((record) => [
      record, record.conversation, record.thread, record.threadSummary,
      record.composerTarget, record.target,
    ].filter((value) => value && typeof value === "object"));
    const matching = routeId ? expanded.filter((record) => identity(record) === routeId) : expanded.filter((record) =>
      (composerId && record.composerId === composerId) || record.kind === "local" && typeof record.cwd === "string");
    // 首页项目路由的 projectContext 来自当前 route，不使用侧栏最近选择。
    const project = route?.value?.projectContext;
    if (!routeId && project?.hostId && typeof project.projectId === "string"
        && /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(project.projectId)) {
      matching.push({ cwd: project.projectId, hostId: project.hostId });
    }
    const ids = new Set(matching.map(identity).filter(Boolean));
    if (routeId) ids.add(routeId);
    if (ids.size > 1) return { reason: "当前输入框的会话信息不一致" };
    let sessionId = routeId || [...ids][0] || "";
    const hosts = new Set(matching.map((record) => record.hostId).filter((host) => typeof host === "string"));
    if (route?.value?.hostId) hosts.add(route.value.hostId);
    // 侧栏仅补充相同会话的主机身份，不能覆盖输入框所属的会话。
    if (sessionId && typeof currentSessionRef === "function") {
      const ref = currentSessionRef();
      if (ref.session_id === sessionId && ref.host_id) hosts.add(ref.host_id);
    }
    if (hosts.size !== 1) return { sessionId, reason: "未确认当前输入框所属的主机" };
    const hostId = [...hosts][0];
    if (hostId !== "local") return { sessionId, hostId, reason: "远程项目暂不附带上下文" };
    const paths = new Set(matching.map((record) => record.cwd).filter((cwd) => typeof cwd === "string" && cwd.trim()));
    if (paths.size > 1) return { sessionId, hostId, reason: "当前输入框的项目目录不一致" };
    const cwd = [...paths][0] || "";
    return { sessionId, hostId, workingDirectory: cwd, scope: route };
  }

  async function codexPlusPromptEnhanceProject(target, identityOnly = false) {
    const config = codexPlusBackendSettings.promptEnhance?.context;
    if (!identityOnly && (!config?.enabled || !["project", "instructions", "directory", "manifests"].some((key) => config[key]))) return null;
    const location = codexPlusPromptEnhanceLocation(target.editor, target.native?.composerId);
    const output = { sessionId: location.sessionId || "", hostId: location.hostId || "", workingDirectory: location.workingDirectory || "" };
    if (location.reason) return { ...output, reason: location.reason };
    const sessionId = location.sessionId;
    let cwd = location.workingDirectory;
    // AppServerManager 的只读目录接口不取历史，导出名按能力识别。
    if (!cwd && sessionId && location.scope) {
      try {
        const module = await loadOptionalCodexAppModule("app-initial-");
        const getters = Object.values(module || {}).filter((fn) => {
          if (typeof fn !== "function") return false;
          try {
            const source = Function.prototype.toString.call(fn);
            return source.includes(".forHost(") && source.includes("AppServerManager RPC");
          } catch { return false; }
        });
        if (getters.length === 1) {
          const manager = getters[0](location.scope, location.hostId);
          if (typeof manager?.getConversationCwd === "function") {
            cwd = await manager.getConversationCwd(sessionId);
          }
        }
      } catch {}
    }
    // 只用已确认主机的客户端，不尝试其他主机；includeTurns:false 不读取会话正文。
    if (!cwd && sessionId) {
      try {
        let client = typeof nativeHostClient === "function" ? nativeHostClient(location.hostId) : null;
        if (!client && typeof discoverNativeHostClient === "function") {
          client = await discoverNativeHostClient({ session_id: sessionId, host_id: location.hostId });
        }
        if (client) {
          const result = await client.sendRequest("thread/read", { threadId: sessionId.replace(/^local:/, ""), includeTurns: false });
          const thread = result?.thread || result?.result?.thread;
          if (thread?.id === sessionId.replace(/^local:/, "")) cwd = thread.cwd;
        }
      } catch {}
    }
    const current = codexPlusPromptEnhanceLocation(target.editor, target.native?.composerId);
    if (!target.editor.isConnected || window.location.href !== target.href || current.sessionId !== sessionId || current.hostId !== location.hostId) {
      return { ...output, workingDirectory: "", reason: "会话已变化，项目上下文已跳过" };
    }
    if (typeof cwd !== "string" || !/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(cwd)) {
      return { ...output, reason: "未取得当前输入框的项目目录" };
    }
    return { ...output, workingDirectory: cwd };
  }
