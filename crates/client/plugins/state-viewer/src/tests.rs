use super::*;
include!("json_tests.rs");

fn ctx(surface: &str) -> Value {
    json!({"server_origin":"https://example.test","owner_id":"owner","session_id":"session","instance_generation":3,
        "history_generation":1,"locale":"en","target_visible":true,"invocation_id":"083cfa38-658d-4a07-8bee-90f5aedca7c0",
        "surface":{"surface_id":surface,"target":"sidebar"}})
}
fn initial(c: &Value) -> Value {
    init(c)["vars_patch"].clone()
}
fn no_request(_: &str, _: &Value) -> Result<u32, String> {
    panic!("unexpected host request")
}
fn inspection(revision: &str) -> Value {
    json!({"values":{"owned":{"nested":[1,false,null]},"delegated":42,"hidden":"original secret","framework":0,"init":"fact"},
        "metadata":{
            "owned":{"visibility":"visible","persistence":"persisted","owner":"client","editors":["client","agent"]},
            "delegated":{"visibility":"visible","persistence":"persisted","owner":"agent","editors":["client","agent"]},
            "hidden":{"visibility":"invisible","persistence":"ephemeral","owner":"client","editors":["client"]},
            "init":{"visibility":"visible","persistence":"persisted","owner":"client","editors":["client"]}},
        "descriptors":{
            "owned":{"kind":"custom","editable":true,"owner_editable":true,"deletable":true},
            "delegated":{"kind":"custom","editable":true,"owner_editable":false,"deletable":false},
            "hidden":{"kind":"custom","editable":true,"owner_editable":true,"deletable":true},
            "framework":{"kind":"framework","editable":false,"owner_editable":false,"deletable":false,"reason":"Framework counters are read-only"},
            "init":{"kind":"framework","editable":false,"owner_editable":false,"deletable":false,"reason":"Initialization fact is read-only"}},
        "witness":{"runtime_instance_id":"incarnation","variables_revision":revision}})
}
fn snapshot(c: &Value) -> Value {
    let mut v = initial(c);
    inspect(&mut v, &inspection("1")).unwrap();
    v["stale"] = false.into();
    view::derive(&mut v, c);
    v
}
fn action(v: &Value, c: &Value, a: &str, p: Value) -> Value {
    on_action(a, &p, v, c, no_request)["vars_patch"].clone()
}

#[test]
fn atomic_snapshot_validates_every_component_and_preserves_last_complete_values() {
    let c = ctx("one");
    let mut v = snapshot(&c);
    let before = v["values"].clone();
    for key in ["values", "metadata", "descriptors", "witness"] {
        let mut invalid = inspection("2");
        invalid[key] = Value::Null;
        assert!(inspect(&mut v, &invalid).is_err());
        assert_eq!(v["values"], before);
    }
    let mut invalid = inspection("2");
    invalid["witness"]["variables_revision"] = 2.into();
    assert!(inspect(&mut v, &invalid).is_err());
    let mut large = inspection("2");
    large["values"]["large"] = "x".repeat(4 * 1024 * 1024).into();
    assert!(inspect(&mut v, &large).unwrap_err().contains("budget"));
    assert_eq!(v["values"], before);
}
#[test]
fn all_identity_and_history_fences_drop_drafts_and_pending_work() {
    let c = ctx("one");
    let v = pending(&c);
    for key in [
        "owner_id",
        "session_id",
        "instance_generation",
        "history_generation",
        "server_origin",
    ] {
        let mut next = c.clone();
        next[key] = json!("different");
        next["target_visible"] = false.into();
        let v = on_phase(
            "event-result",
            &json!({"request_id":50,"ok":true,"value":inspection("2")}),
            &v,
            &next,
            no_request,
        )["vars_patch"]
            .clone();
        assert_eq!(v["surfaces"], json!({}));
        assert_eq!(v["values"], json!({}));
    }
    let mut hidden = c;
    hidden["target_visible"] = false.into();
    let reset =
        on_phase("history-reset", &json!({}), &v, &hidden, no_request)["vars_patch"].clone();
    assert_eq!(reset["surfaces"], json!({}));
    assert_eq!(reset["has_snapshot"], false);
}
#[test]
fn large_original_values_are_not_truncated_and_final_budget_is_explicit() {
    let c = ctx("one");
    let mut v = snapshot(&c);
    let original = "x".repeat(2 * 1024 * 1024 - 1024);
    v["values"]["hidden"] = original.clone().into();
    view::derive(&mut v, &c);
    let shown = action(&v, &c, "toggle-invisible", Value::Null);
    assert_eq!(shown["display_values"]["hidden"], original);
    assert_eq!(shown["values"]["hidden"], original);
    let huge = result(json!({"projection":"x".repeat(16*1024*1024)}));
    assert!(huge.get("vars_patch").is_none());
    assert!(huge["error"].as_str().unwrap().contains("budget"));
}
#[test]
fn pending_inspection_remount_and_new_surface_restart_one_atomic_read() {
    let mut a = ctx("a");
    a["surface_generation"] = 1.into();
    let started = render("sidebar", &initial(&a), &a, |kind, _| {
        assert_eq!(kind, "state-inspection");
        Ok(80)
    })["vars_patch"]
        .clone();
    assert_eq!(started["inspection_surface"], "a");
    a["surface_generation"] = 3.into();
    let restarted = render("sidebar", &started, &a, |kind, _| {
        assert_eq!(kind, "state-inspection");
        Ok(81)
    })["vars_patch"]
        .clone();
    assert_eq!(restarted["inspection_request"], 81);
    assert_eq!(restarted["inspection_generation"], 3);
    let mut b = ctx("b");
    b["surface_generation"] = 1.into();
    let transferred = render("expanded-page", &restarted, &b, |kind, _| {
        assert_eq!(kind, "state-inspection");
        Ok(82)
    })["vars_patch"]
        .clone();
    assert_eq!(transferred["inspection_surface"], "b");
    assert_eq!(transferred["inspection_request"], 82);
    let delayed = on_phase(
        "event-result",
        &json!({"request_id":81,"ok":true,"value":inspection("1")}),
        &transferred,
        &a,
        no_request,
    )["vars_patch"]
        .clone();
    assert_eq!(delayed["inspection_request"], 82);
    assert_eq!(delayed["has_snapshot"], false);
    let settled = on_phase(
        "event-result",
        &json!({"request_id":82,"ok":true,"value":inspection("2")}),
        &delayed,
        &b,
        no_request,
    )["vars_patch"]
        .clone();
    assert_eq!(settled["has_snapshot"], true);
    assert_eq!(settled["loading"], false);
    assert_eq!(settled["witness"], inspection("2")["witness"]);
}
#[test]
fn surface_less_history_reset_read_is_not_replaced_by_mounted_renders() {
    let mut mounted = ctx("sidebar");
    mounted["surface_generation"] = 1.into();
    let mut global = mounted.clone();
    global["surface"] = Value::Null;
    global["surface_generation"] = Value::Null;
    let reset = on_phase(
        "history-reset",
        &json!({}),
        &snapshot(&mounted),
        &global,
        |kind, _| {
            assert_eq!(kind, "state-inspection");
            Ok(90)
        },
    )["vars_patch"]
        .clone();
    assert_eq!(reset["inspection_request"], 90);
    assert!(reset["inspection_surface"].is_null());
    let rendered = render("sidebar", &reset, &mounted, no_request)["vars_patch"].clone();
    assert_eq!(rendered["inspection_request"], 90);
    let mut expanded = ctx("expanded");
    expanded["surface_generation"] = 2.into();
    let rendered = render("expanded-page", &rendered, &expanded, no_request)["vars_patch"].clone();
    assert_eq!(rendered["inspection_request"], 90);
    assert_eq!(rendered["loading"], true);
    let completed = on_phase(
        "event-result",
        &json!({"request_id":90,"ok":true,"value":inspection("2")}),
        &rendered,
        &global,
        no_request,
    )["vars_patch"]
        .clone();
    assert_eq!(completed["has_snapshot"], true);
    assert_eq!(completed["loading"], false);
    assert_eq!(completed["witness"], inspection("2")["witness"]);
}

#[test]
fn setting_page_without_session_is_localized_and_never_imports_state() {
    for (locale, expected) in [("en", "Session required"), ("zh-CN", "需要会话")] {
        let mut c = ctx("settings");
        c["session_id"] = Value::Null;
        c["locale"] = locale.into();
        c["surface"]["target"] = "setting-page".into();
        // Flat host context must win even if an untrusted nested value exists.
        c["session"] = json!({"id":"not-authority"});
        let output = render("setting-page", &snapshot(&ctx("old")), &c, no_request);
        assert_eq!(output["tree"]["type"], "notice");
        assert!(output["tree"]["props"]["text"].as_str().unwrap().contains(expected));
        assert!(output.get("vars_patch").is_none());
    }
}
