# Codex3N

[中文](README.md) · [Download](https://github.com/nk33-dev/Codex3N/releases/latest) · [Personal documentation](doc/person/README.md) · [Upstream](https://github.com/BigPizzaV3/CodexPlusPlus)

A personal fork of CodexPlusPlus that adds provider switching, protocol conversion, session management and UI enhancements to the OpenAI Codex / ChatGPT desktop app. It runs through CDP and local services and does not modify the official app's `app.asar`.

## Install

Download from [Releases](https://github.com/nk33-dev/Codex3N/releases/latest):

- Windows: `Codex3N-<version>-windows-x64-setup.exe`
- macOS: `Codex3N-<version>-macos-universal.dmg` (Intel and Apple Silicon)

Open **Codex++**, confirm the official app path, configure providers and enhancements, then start the official app from Overview. The interface and background services share one application; closing the window keeps it in the tray. Check for updates on the About page.

The macOS package uses ad-hoc signing and is not notarized by Apple. If macOS blocks it, verify the download source, then run:

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Codex++.app"
```

## Differences from upstream

**Providers and models**
- Provider takeover is off by default; import the system default configuration, keep several named API keys and switch between them instantly.
- Native and provider models are merged and sorted, keeping manual context windows and auto-compaction settings.

**Sessions**
- Full-library session search and pagination, invalid-session checks and hiding, backup before deletion, and project association recovery.

**Prompt tools** (off by default; enable in the manager under Codex enhancements → Prompt enhancement)
- **Enhance prompt**: turns a draft into a prompt that is ready to send. Decisions that can be made are written out; facts only you know become blanks such as 【list page URL】.
- **Clarify needs**: asks about gaps in the draft, with a recommended choice and rationale for single-choice questions, and generates as soon as the direction is clear.
- **Saved prompts**: save, search and filter by tag, then append or replace into the composer.
- Polish / Standard / Detailed depths and audience profiles from no technical experience to P4–P10. Results are written back only after you confirm and are never sent automatically.

**Interface and runtime**
- Removes advertising and recommendations.
- Background refresh in the manager, floating-panel interaction, host compatibility and mobile relay fixes.
- Automatic backend recovery and manual reconnection while keeping the current page and conversation.

Upstream features remain available, including providers, plugins, WeChat, skins, user scripts, dictation, cache cleaning, the usage status line and automatic takeover of the official app. In official-login + API mode, model requests always use the configured API; test the connection in the manager first.

The fork also includes upstream's resident protocol proxy, request retries and logs, Claude Code providers, side-chat saving, and turn rewind. Computer Use requires the supported macOS runtime. See the [runtime documentation](doc/person/runtime.md) for platform limits and data protection.

See the [personal documentation](doc/person/README.md) for behavior and code entry points.

## Development and maintenance

Development and releases use the `personal` branch; versions follow `<upstream-version>-3n.N`. See the [maintenance guide](doc/person/maintenance.md) for upstream sync, checks and releases.

Official app updates may affect injection compatibility. Configuration and session data live in `CODEX_HOME` (default `~/.codex`); back them up before making changes.

## License

Copyright (C) 2026 BigPizzaV3. Licensed under [AGPL-3.0-only](LICENSE): modified distributions and network services must provide the corresponding source code. The license covers this project's code only and grants no rights to OpenAI or other third-party trademarks or application assets.
