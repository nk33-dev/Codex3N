use serde_json::Value;
use std::sync::LazyLock;

static PREFERENCES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../assets/prompt-enhance/preferences.json"
    ))
    .expect("bundled prompt preferences")
});

pub(super) fn guidance(detail: &str, audience: &str) -> String {
    let rule = |group: &str, value: &str, fallback: &str| {
        let entries = PREFERENCES[group].as_array().unwrap();
        entries
            .iter()
            .find(|entry| entry["value"] == value)
            .or_else(|| entries.iter().find(|entry| entry["value"] == fallback))
            .unwrap()["rule"]
            .as_str()
            .unwrap()
    };
    format!(
        "{}\n{}\n本次最多提出 {} 题；这是上限，不是题数目标。",
        rule("details", detail, "standard"),
        rule("audiences", audience, "p4"),
        question_limit(detail)
    )
}

pub(super) fn question_limit(detail: &str) -> usize {
    PREFERENCES["questionLimits"][detail].as_u64().unwrap_or(7) as usize
}

pub(super) fn output_budget(detail: &str) -> u32 {
    PREFERENCES["outputBudgets"][detail]
        .as_u64()
        .unwrap_or(4096) as u32
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_selected_preferences_are_sent() {
        let rules = super::guidance("detailed", "p4");
        assert!(rules.contains("题数完全取决"));
        assert!(rules.contains("已有") || rules.contains("有基础"));
        assert!(!rules.contains("P10"));
        assert!(super::guidance("concise", "nontechnical").contains("不要求用户先懂术语"));
    }
}
