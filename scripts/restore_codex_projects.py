"""从现存项目目录与会话数据库恢复新版 Codex 侧栏关联。"""

import argparse
import csv
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
from contextlib import closing
from datetime import datetime
from pathlib import Path


def normalized_path(path):
    path = path.replace("\\", "/").lower()
    if path.startswith("//?/"):
        path = path[4:]
    return path.rstrip("/")


def prepare_recovery(state, projects, threads, home):
    local_projects = state.get("local-projects")
    mappings_by_host = state.get("app-server-project-id-by-legacy-project-id-by-host")
    if not isinstance(local_projects, dict) or not isinstance(mappings_by_host, dict):
        raise ValueError("未找到新版项目状态或项目 ID 映射，请勿使用此恢复工具")
    host_key = f"local:{home}"
    mapping = mappings_by_host.get(host_key)
    if not isinstance(mapping, dict):
        raise ValueError("当前 CODEX_HOME 的项目 ID 映射不存在，请勿猜测宿主 ID")

    order = state.get("project-order")
    assignments = state.get("thread-project-assignments")
    membership = state.get("thread-project-membership-host-ids")
    projectless = state.get("projectless-thread-ids", [])
    if not isinstance(order, list) or not isinstance(assignments, dict) or not isinstance(membership, dict):
        raise ValueError("侧栏关联字段格式不符合预期")
    if not isinstance(projectless, list):
        raise ValueError("无项目会话字段格式不符合预期")

    existing_by_db_id = {db_id: local_id for local_id, db_id in mapping.items() if local_id in local_projects}
    roots_by_path = {}
    local_by_db_id = {}
    new_projects = 0
    for project_id, name, created_at, updated_at, roots in projects:
        local_id = existing_by_db_id.get(project_id)
        if local_id is None:
            local_id = str(uuid.uuid4())
            local_projects[local_id] = {
                "id": local_id,
                "name": name,
                "rootPaths": roots,
                "createdAt": created_at,
                "updatedAt": updated_at,
            }
            mapping[local_id] = project_id
            new_projects += 1
        if local_id not in order:
            order.append(local_id)
        local_by_db_id[project_id] = local_id
        for root in roots:
            roots_by_path.setdefault(normalized_path(root), []).append((local_id, project_id))

    projectless_ids = set(projectless)
    updates = []
    for thread_id, cwd, project_id, archived in threads:
        if archived or thread_id in projectless_ids:
            continue
        existing = assignments.get(thread_id)
        if existing is not None:
            if not isinstance(existing, dict) or existing.get("projectKind") != "local":
                continue
            local_id = existing.get("projectId")
            db_id = mapping.get(local_id)
            if db_id not in local_by_db_id:
                continue
        elif project_id in local_by_db_id:
            db_id = project_id
            local_id = local_by_db_id[db_id]
        else:
            if project_id is not None:
                continue
            candidates = roots_by_path.get(normalized_path(cwd), [])
            if len(candidates) != 1:
                continue
            local_id, db_id = candidates[0]
        if existing is None:
            assignments[thread_id] = {"projectKind": "local", "projectId": local_id}
            membership[thread_id] = "local"
        if project_id is None:
            updates.append((db_id, thread_id))
    return new_projects, updates


def load_database(connection):
    required = {"projects", "project_roots", "threads"}
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not required <= tables:
        raise ValueError("state_5.sqlite 缺少新版项目或会话表")
    projects = []
    for row in connection.execute(
        "SELECT id, name, created_at_ms, updated_at_ms FROM projects ORDER BY position, id"
    ):
        roots = [item[0] for item in connection.execute(
            "SELECT path FROM project_roots WHERE project_id=? ORDER BY position", (row[0],)
        )]
        if roots:
            projects.append((*row, roots))
    threads = list(connection.execute("SELECT id, cwd, project_id, archived FROM threads"))
    return projects, threads


def recover(home, apply=False):
    state_path = home / ".codex-global-state.json"
    db_path = home / "state_5.sqlite"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if not isinstance(state, dict):
        raise ValueError("全局状态不是 JSON 对象")
    original_state = json.dumps(state, sort_keys=True)
    with closing(sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)) as connection:
        projects, threads = load_database(connection)
        new_projects, updates = prepare_recovery(state, projects, threads, home)
        if not apply or (original_state == json.dumps(state, sort_keys=True) and not updates):
            return new_projects, len(updates), None

        backup_dir = home / "backups_state" / "project-recovery" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup_dir.mkdir(parents=True, exist_ok=False)
        shutil.copy2(state_path, backup_dir / state_path.name)
        with closing(sqlite3.connect(backup_dir / db_path.name)) as backup:
            connection.backup(backup)

    staged_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=home, prefix=".project-recovery-", delete=False) as staged:
            staged_path = Path(staged.name)
            json.dump(state, staged, ensure_ascii=False, indent=2)
            staged.write("\n")
            staged.flush()
            os.fsync(staged.fileno())
        with closing(sqlite3.connect(db_path, timeout=5)) as connection, connection:
            connection.executemany(
                "UPDATE threads SET project_id=? WHERE id=? AND project_id IS NULL AND archived=0",
                updates,
            )
        os.replace(staged_path, state_path)
    finally:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)
    return new_projects, len(updates), backup_dir


def codex_is_running():
    if os.name != "nt":
        return False
    result = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, check=True
    )
    return any(
        row and row[0].lower() in {"codex.exe", "codex-plus-plus.exe"}
        for row in csv.reader(result.stdout.splitlines())
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--apply", action="store_true", help="确认 Codex 桌面版和 CLI 已完全退出后写入")
    args = parser.parse_args()
    if args.apply and (os.environ.get("CODEX_THREAD_ID") or os.environ.get("CODEX_SESSION_ID")):
        parser.error("请退出 Codex 并在独立终端运行恢复命令")
    try:
        if args.apply and codex_is_running():
            parser.error("检测到 Codex 仍在运行；请完全退出桌面版和管理器后再执行")
        projects, threads, backup = recover(args.home.resolve(), args.apply)
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"恢复中止：{error}\n")
    print(f"待恢复项目 {projects} 个、可明确匹配的会话 {threads} 条")
    if backup:
        print(f"原始状态及一致性数据库备份：{backup}")
    elif not args.apply:
        print("仅预览，未修改任何数据；完全退出 Codex 后加 --apply 执行")


if __name__ == "__main__":
    main()
