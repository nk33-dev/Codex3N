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
        rule("audiences", audience, "p4"),
        rule("details", detail, "standard"),
        question_limit(detail)
    )
}

pub(super) fn question_limit(detail: &str) -> usize {
    PREFERENCES["questionLimits"][detail].as_u64().unwrap_or(10) as usize
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

    #[test]
    fn every_profile_keeps_the_users_task_and_reader_authoritative() {
        for detail in ["concise", "standard", "detailed"] {
            for audience in ["nontechnical", "p4", "p5", "p6", "p7", "p8", "p9", "p10"] {
                let rules = super::guidance(detail, audience);
                assert!(rules.contains("实际读者、任务类型、范围和格式以用户要求为准"));
                assert!(!rules.contains("目标、技术栈、核心业务、约束"));
                let depth = super::PREFERENCES["details"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|entry| entry["value"] == detail)
                    .unwrap()["rule"]
                    .as_str()
                    .unwrap();
                assert!(
                    rules.find(depth).unwrap()
                        > rules
                            .find("实际读者、任务类型、范围和格式以用户要求为准")
                            .unwrap()
                );
            }
        }
    }
}
