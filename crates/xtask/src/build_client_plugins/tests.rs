use super::*;
fn metadata() -> Value {
    json!({"workspace_members":["viewer","fixture","agent","browser"],"packages":[
        {"id":"viewer","name":"viewer","metadata":{"microcrab":{"artifact-kind":"client-plugin","component-name":"state-viewer","plugin-id":"microcrab.state-viewer","default-enabled":true}},"targets":[{"name":"viewer_module","crate_types":["cdylib","rlib"]}]},
        {"id":"fixture","name":"fixture","metadata":{"microcrab":{"artifact-kind":"client-plugin","component-name":"fixture","plugin-id":"microcrab.fixture","default-enabled":false}},"targets":[{"name":"fixture_module","crate_types":["cdylib"]}]},
        {"id":"agent","name":"agent","metadata":{"microcrab":{"artifact-kind":"agent","component-name":"agent"}},"targets":[{"name":"agent","crate_types":["cdylib"]}]},
        {"id":"browser","name":"browser","metadata":{"microcrab":{"artifact-kind":"frontend-host"}},"targets":[{"name":"browser","crate_types":["cdylib"]}]}
    ]})
}
#[test]
fn plugins_are_distinct_from_agents_and_browser_hosts_before_selection() {
    let data = metadata();
    let plugins = discover(&data, &BTreeSet::new()).unwrap();
    assert_eq!(plugins.len(), 2);
    assert_eq!(plugins[0].id, "microcrab.fixture");
    assert!(!plugins[0].default_enabled);
    assert!(plugins[1].default_enabled);
    let selected = BTreeSet::from(["viewer".into()]);
    assert_eq!(
        discover(&data, &selected).unwrap()[0].module,
        "viewer_module"
    );
    for name in ["agent", "browser", "absent"] {
        assert!(discover(&data, &BTreeSet::from([name.into()])).is_err());
    }
    let mut unknown = data.clone();
    unknown["packages"][3]["metadata"]["microcrab"]["artifact-kind"] = "unknown".into();
    assert!(
        discover(&unknown, &selected)
            .unwrap_err()
            .to_string()
            .contains("unknown microcrab artifact-kind")
    );
}
#[test]
fn malformed_and_colliding_declarations_fail_without_building() {
    for (field, value) in [
        ("plugin-id", json!("../escape")),
        ("component-name", json!("")),
        ("default-enabled", json!("true")),
        ("artifact-kind", json!(3)),
    ] {
        let mut data = metadata();
        data["packages"][0]["metadata"]["microcrab"][field] = value;
        assert!(discover(&data, &BTreeSet::new()).is_err(), "{field}");
    }
    let mut data = metadata();
    data["packages"][1]["metadata"]["microcrab"]["plugin-id"] = "microcrab.state-viewer".into();
    assert!(discover(&data, &BTreeSet::new()).is_err());
}
#[test]
fn supersedes_discovery_and_install_records_preserve_optional_shape() {
    let mut data = metadata();
    let hash = "d758213d4827327b8c41df43152b46d0c2a78d9930b1fdd892481a8245e53587";
    data["packages"][0]["metadata"]["microcrab"]["supersedes"] = json!([hash]);
    let plugins = discover(&data, &BTreeSet::new()).unwrap();
    assert!(plugins[0].supersedes.is_empty());
    assert_eq!(plugins[1].supersedes, vec![hash]);
    assert_eq!(
        installed_record(&plugins[0], "fixture.wasm", hash),
        json!({"id":"microcrab.fixture","file":"fixture.wasm","sha256":hash,"default_enabled":false})
    );
    assert_eq!(
        installed_record(&plugins[1], "viewer.wasm", hash),
        json!({"id":"microcrab.state-viewer","file":"viewer.wasm","sha256":hash,"default_enabled":true,"supersedes":[hash]})
    );
    data["packages"][0]["metadata"]["microcrab"]["supersedes"] = json!([]);
    let plugins = discover(&data, &BTreeSet::from(["viewer".into()])).unwrap();
    assert!(plugins[0].supersedes.is_empty());
    assert!(
        installed_record(&plugins[0], "viewer.wasm", hash)
            .get("supersedes")
            .is_none()
    );
    data["packages"][0]["metadata"]["microcrab"]["supersedes"] = json!(vec![hash; 16]);
    assert_eq!(
        discover(&data, &BTreeSet::new()).unwrap()[1]
            .supersedes
            .len(),
        16
    );
}
#[test]
fn malformed_supersedes_fail_discovery_even_before_selection() {
    let hash = "a".repeat(64);
    for value in [
        Value::Null,
        json!(hash),
        json!({}),
        json!(false),
        json!([null]),
        json!([42]),
        json!(["a".repeat(63)]),
        json!(["a".repeat(65)]),
        json!(["A".repeat(64)]),
        json!(["g".repeat(64)]),
        json!(vec![hash; 17]),
    ] {
        let mut data = metadata();
        data["packages"][0]["metadata"]["microcrab"]["supersedes"] = value.clone();
        let error = discover(&data, &BTreeSet::from(["fixture".into()])).unwrap_err();
        assert!(error.to_string().contains("supersedes"), "{value}: {error}");
    }
}
#[test]
fn cli_profiles_and_selections_are_explicit() {
    for args in [
        vec!["--release", "--debug"],
        vec!["--only"],
        vec!["--only", "viewer,,fixture"],
        vec!["--install-dir", "--debug"],
        vec!["--unknown"],
    ] {
        assert!(parse(args.into_iter().map(str::to_owned)).is_err());
    }
    let options = parse(
        [
            "--release",
            "--validate",
            "--install",
            "--only",
            "viewer,fixture",
        ]
        .into_iter()
        .map(str::to_owned),
    )
    .unwrap()
    .unwrap();
    assert!(options.release && options.validate);
    assert_eq!(options.install, Some("frontend/public/plugins".into()));
    assert_eq!(options.only.len(), 2);
}
#[test]
fn validation_rejects_core_modules_even_when_valid_wasm() {
    assert!(
        validate_component(b"\0asm\x01\0\0\0")
            .unwrap_err()
            .to_string()
            .contains("not a Component")
    );
    assert!(validate_component(b"not wasm").is_err());
    // Empty Component header is valid; guest semantics/imports are inspected by
    // the runtime before it calls a plugin's manifest, never inferred from ids.
    assert!(validate_component(b"\0asm\x0d\0\x01\0").is_ok());
}
