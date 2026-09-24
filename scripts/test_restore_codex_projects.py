import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from restore_codex_projects import recover


class RestoreCodexProjectsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        existing_id = "11111111-1111-1111-1111-111111111111"
        self.state_path = self.home / ".codex-global-state.json"
        self.state_path.write_text(json.dumps({
            "local-projects": {
                existing_id: {
                    "id": existing_id, "name": "Current", "rootPaths": ["C:\\current"],
                    "createdAt": 1, "updatedAt": 1,
                }
            },
            "project-order": [existing_id],
            "thread-project-assignments": {
                "existing": {"projectKind": "local", "projectId": existing_id}
            },
            "thread-project-membership-host-ids": {"existing": "local"},
            "projectless-thread-ids": ["projectless"],
            "app-server-project-id-by-legacy-project-id-by-host": {
                f"local:{self.home}": {existing_id: "db-current"}
            },
        }), encoding="utf-8")
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as connection:
            connection.executescript(r"""
                PRAGMA foreign_keys=ON;
                CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER,
                    created_at_ms INTEGER, updated_at_ms INTEGER);
                CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
                CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, project_id TEXT,
                    archived INTEGER);
                INSERT INTO projects VALUES ('db-current', 'Current', 0, 1, 1);
                INSERT INTO projects VALUES ('db-old', 'Old', 1, 2, 2);
                INSERT INTO project_roots VALUES ('db-current', 0, 'C:\current');
                INSERT INTO project_roots VALUES ('db-old', 0, 'D:\old');
                INSERT INTO threads VALUES ('existing', 'C:\current', NULL, 0);
                INSERT INTO threads VALUES ('old', '\\?\D:\old', NULL, 0);
                INSERT INTO threads VALUES ('projectless', 'D:\old', NULL, 0);
                INSERT INTO threads VALUES ('archived', 'D:\old', NULL, 1);
                INSERT INTO threads VALUES ('unmatched', 'E:\another', NULL, 0);
            """)

    def test_dry_run_and_apply_preserve_explicit_assignments(self):
        original = self.state_path.read_bytes()
        self.assertEqual(recover(self.home), (1, 2, None))
        self.assertEqual(self.state_path.read_bytes(), original)

        new_projects, updated_threads, backup = recover(self.home, apply=True)
        self.assertEqual((new_projects, updated_threads), (1, 2))
        self.assertEqual((backup / self.state_path.name).read_bytes(), original)
        with closing(sqlite3.connect(backup / "state_5.sqlite")) as connection:
            self.assertIsNone(connection.execute("SELECT project_id FROM threads WHERE id='old'").fetchone()[0])

        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(len(state["local-projects"]), 2)
        old_id = state["project-order"][1]
        self.assertEqual(state["thread-project-assignments"]["old"]["projectId"], old_id)
        self.assertNotIn("projectless", state["thread-project-assignments"])
        self.assertNotIn("archived", state["thread-project-assignments"])
        self.assertNotIn("unmatched", state["thread-project-assignments"])
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as connection:
            self.assertEqual(connection.execute("SELECT project_id FROM threads WHERE id='old'").fetchone()[0], "db-old")
            self.assertEqual(connection.execute("SELECT project_id FROM threads WHERE id='existing'").fetchone()[0], "db-current")

        self.assertEqual(recover(self.home), (0, 0, None))

    def test_missing_order_is_written_even_when_threads_are_already_assigned(self):
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        state["project-order"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as connection, connection:
            connection.execute("DELETE FROM threads")
            connection.execute("DELETE FROM projects WHERE id='db-old'")
            connection.execute("DELETE FROM project_roots WHERE project_id='db-old'")

        projects, threads, backup = recover(self.home, apply=True)
        self.assertEqual((projects, threads), (0, 0))
        self.assertIsNotNone(backup)
        self.assertEqual(json.loads(self.state_path.read_text())["project-order"], [
            "11111111-1111-1111-1111-111111111111"
        ])


if __name__ == "__main__":
    unittest.main()
