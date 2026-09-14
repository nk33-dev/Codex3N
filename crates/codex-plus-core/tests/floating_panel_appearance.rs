#[test]
fn appearance_fragments_expose_the_expected_contract() {
    let runtime = include_str!("../../../assets/inject/floating-panel/core/appearance-runtime.js");
    let stylesheet = include_str!("../../../assets/inject/floating-panel/core/appearance.js");

    assert!(runtime.starts_with("/* Floating-panel appearance runtime:"));
    assert!(stylesheet.starts_with("/* Floating-panel appearance:"));
    assert!(runtime.contains("function installTypographyObserver"));
    assert!(runtime.contains("function applyMaterial"));
    assert!(stylesheet.contains("prefers-reduced-motion"));
    let reduced_motion = stylesheet
        .rsplit_once("@media (prefers-reduced-motion: reduce)")
        .expect("reduced motion block")
        .1;
    let progress_style = reduced_motion
        .split(".csw-completion-beam")
        .next()
        .expect("progress reduced motion style");
    assert!(progress_style.contains(".csw-progress-ring"));
    assert!(progress_style.contains("animation: none !important"));
    assert!(progress_style.contains("box-shadow: 0 0 0 4px"));
    assert!(!runtime.contains("import "));
    assert!(!runtime.contains("export "));
    assert!(!stylesheet.contains("import "));
    assert!(!stylesheet.contains("export "));
}
