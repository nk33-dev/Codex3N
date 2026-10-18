use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    schema_version: u64,
    values: BTreeMap<String, String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub maximized: bool,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

fn path() -> std::path::PathBuf {
    codex_plus_core::paths::default_app_state_dir().join("ui-preferences.json")
}

pub fn read() -> anyhow::Result<Preferences> {
    match std::fs::read(path()) {
        Ok(bytes) => {
            let prefs: Preferences = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(prefs.schema_version <= 1, "界面偏好由较新版本创建");
            Ok(prefs)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(error) => Err(error.into()),
    }
}

fn update(change: impl FnOnce(&mut Preferences)) -> anyhow::Result<()> {
    use fs2::FileExt;
    let path = path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))?;
    lock.lock_exclusive()?;
    let mut prefs = read()?;
    change(&mut prefs);
    prefs.schema_version = 1;
    codex_plus_core::settings::atomic_write(&path, &serde_json::to_vec_pretty(&prefs)?)
}

#[tauri::command]
pub fn load_ui_preferences() -> Result<serde_json::Value, String> {
    read()
        .map(|prefs| serde_json::json!({"values": prefs.values, "importLegacy": !path().with_extension("imported").exists()}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_ui_preferences(values: BTreeMap<String, String>) -> Result<(), String> {
    if values.len() > 256
        || values
            .iter()
            .any(|(key, value)| !allowed(key) || key.len() > 256 || value.len() > 4096)
    {
        return Err("界面偏好格式无效".into());
    }
    update(|prefs| prefs.values.extend(values)).map_err(|error| error.to_string())?;
    codex_plus_core::settings::atomic_write(&path().with_extension("imported"), b"1")
        .map_err(|error| error.to_string())
}

fn allowed(key: &str) -> bool {
    matches!(key, "codex-plus-theme" | "codex-plus-lang")
        || key.starts_with("codex-plus-relay-fold:")
}

pub fn save_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let size = size.to_logical::<f64>(scale);
    if size.width < 400.0 || size.height < 300.0 {
        return;
    }
    if let Err(error) = update(|prefs| {
        prefs.maximized = maximized;
        if !maximized {
            prefs.width = Some(size.width);
            prefs.height = Some(size.height);
        }
    }) {
        eprintln!("保存窗口偏好失败：{error}");
    }
}
