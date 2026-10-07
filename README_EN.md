# Codex3N

[中文](README.md) · [Download](https://github.com/nk33-dev/Codex3N/releases/latest) · [Personal documentation](doc/person/README.md) · [Upstream](https://github.com/BigPizzaV3/CodexPlusPlus)

A personal fork of CodexPlusPlus for the OpenAI Codex / ChatGPT desktop app. It provides provider switching, protocol conversion, session management and UI enhancements through CDP and local services, without modifying the official app's `app.asar`.

## Getting started

Download from [Releases](https://github.com/nk33-dev/Codex3N/releases/latest):

- Windows: `Codex3N-<version>-windows-x64-setup.exe`
- macOS: `Codex3N-<version>-macos-universal.dmg`, supporting Intel and Apple Silicon.

Open **Codex++ Manager** first, confirm the official app path and configure providers and enhancements. Then launch the official app through **Codex++**. Check for updates on the manager's About page.

The macOS package uses ad-hoc signing and is not notarized by Apple. If macOS blocks it, verify the download source before running:

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Codex++.app"
sudo xattr -rd com.apple.quarantine "/Applications/Codex++ 管理工具.app"
```

## Personal changes

- Removes advertising and recommendations.
- Leaves provider management off by default; supports local configuration import, named API keys and immediate key switching.
- Merges and sorts native and provider models while preserving manual context windows and auto-compaction settings.
- Adds session pagination, invalid-session checks and hiding, backed-up deletion and project association recovery.
- Adapts background refresh, floating-panel interaction, host compatibility and mobile relay behavior.

Upstream provider, plugin, WeChat, skin and user-script features remain available. See the [personal documentation](doc/person/README.md) for behavior and code entry points. In official-login + API mode, model requests always use the configured API; test it in the manager before use.

## Development and maintenance

See the [maintenance guide](doc/person/maintenance.md) for synchronization, validation and release steps. Development and releases use `personal`; versions follow `<upstream-version>-3n.N`.

Official app updates may affect injection compatibility. Configuration and session data live in `CODEX_HOME` (default: `~/.codex`); back them up before making changes.

## License

Copyright (C) 2026 BigPizzaV3. Licensed under [AGPL-3.0-only](LICENSE): modified distributions and network services must provide corresponding source code. This license covers this project's code and grants no rights to OpenAI or other third-party trademarks or application assets.
