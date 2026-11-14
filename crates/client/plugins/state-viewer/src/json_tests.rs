
fn captured(v: &Value, c: &Value) -> Value { v["surface_views"][surface_key(c)]["edit_context"].clone() }
fn save_payload(v: &Value, c: &Value, values: &Value) -> Value {
    json!({"value":values.to_string(),"context":captured(v,c),"edit_id":"editor-attempt-1"})
}
fn pending(c: &Value) -> Value {
    let v = snapshot(c);
    let mut values = v["values"].clone(); values["owned"] = Value::Null;
    let p = save_payload(&v,c,&values);
    on_action("save-json", &p, &v, c, |kind, body| {
        assert_eq!(kind,"state-change");
        assert_eq!(body["expected"], inspection("1")["witness"]);
        assert_eq!(body["operation_id"], c["invocation_id"]);
        assert_eq!(body["change"], json!({"set":{"owned":null}}));
        Ok(50)
    })["vars_patch"].clone()
}
#[test]
fn whole_json_diff_is_atomic_and_preserves_attributes_and_all_json_types() {
    let c = ctx("one"); let v = snapshot(&c); let base = captured(&v,&c);
    for value in [json!(null),json!(false),json!(42),json!("text"),json!([null,false]),json!({"nested":[]})] {
        let mut next = v["values"].clone(); next["owned"] = value.clone();
        assert_eq!(editor::diff(&base,&next.to_string()).unwrap(),json!({"set":{"owned":value}}));
    }
    let mut next = v["values"].clone();
    next["owned"] = 99.into(); next["created"] = json!([false,null]);
    next.as_object_mut().unwrap().remove("hidden");
    let change = editor::diff(&base,&next.to_string()).unwrap();
    assert_eq!(change["set"],json!({"owned":99}));
    assert_eq!(change["remove"],json!(["hidden"]));
    assert_eq!(change["scoped_set"],json!([{"name":"created","value":[false,null],"visibility":"visible","persistence":"persisted","editors":["agent","client","runtime"]}]));
    for key in ["framework","init","delegated"] {
        let mut invalid = next.clone();
        if key == "delegated" { invalid.as_object_mut().unwrap().remove(key); } else { invalid[key] = 88.into(); }
        let out = action(&v,&c,"save-json",save_payload(&v,&c,&invalid));
        assert_eq!(out["surfaces"]["one"]["status"],"error");
        assert!(out["surfaces"]["one"]["detail"].as_str().unwrap().starts_with(key));
        assert_eq!(out["surfaces"]["one"]["edit_id"],"editor-attempt-1");
        assert_eq!(out["surfaces"]["one"]["operation_id"],c["invocation_id"]);
    }
}
#[test]
fn root_budget_duplicates_and_noops_fail_or_succeed_before_effects() {
    let c = ctx("one"); let v = snapshot(&c);
    for text in ["null","false","1","[]","\"text\"","{","{\"x\":1,\"x\":2}","{\"x\":{\"a\":1,\"a\":2}}"] {
        let mut p = save_payload(&v,&c,&v["values"]); p["value"] = text.into();
        let out = action(&v,&c,"save-json",p);
        assert_eq!(out["surfaces"]["one"]["status"],"error", "{text}");
    }
    assert!(editor::diff(&captured(&v,&c),&" ".repeat(4*1024*1024+1)).unwrap_err().contains("4 MiB"));
    let noop = action(&v,&c,"save-json",save_payload(&v,&c,&v["values"]));
    assert_eq!(noop["surfaces"]["one"]["status"],"saved");
    assert_eq!(noop["surfaces"]["one"]["detail"],"No changes / 没有更改");
}
#[test]
fn filtered_display_and_refreshed_snapshot_never_become_the_diff_base() {
    let c = ctx("one"); let v = snapshot(&c);
    let filtered = action(&v,&c,"search",json!({"value":"owned"}));
    assert!(filtered["display_values"].get("hidden").is_none());
    assert_eq!(captured(&filtered,&c)["values"],v["values"]);
    let mut next = v["values"].clone(); next["owned"] = 7.into();
    let p = save_payload(&filtered,&c,&next);
    let mut fresh = filtered;
    inspect(&mut fresh,&inspection("2")).unwrap();
    fresh["values"]["new-external"] = 55.into(); view::derive(&mut fresh,&c);
    let out = on_action("save-json",&p,&fresh,&c,|_,body| {
        assert_eq!(body["expected"],inspection("1")["witness"]);
        assert_eq!(body["change"],json!({"set":{"owned":7}})); Ok(50)
    });
    assert_eq!(out["vars_patch"]["surfaces"]["one"]["status"],"saving");
}
#[test]
fn unknown_and_queued_are_observed_without_replay_and_conflict_keeps_context() {
    let c = ctx("one"); let mut v = pending(&c);
    let original = v["surfaces"]["one"]["context"].clone();
    complete(&mut v,&json!({"request_id":50,"ok":false,"error":"deadline"}));
    assert_eq!(v["surfaces"]["one"]["status"],"unknown");
    let p = save_payload(&v,&c,&v["values"]);
    let blocked = action(&v,&c,"save-json",p);
    assert_eq!(blocked["surfaces"]["one"],v["surfaces"]["one"]);
    let mut observed = on_action("observe-json",&Value::Null,&v,&c,|kind,body| {
        assert_eq!(kind,"state-operation"); assert_eq!(body["operation_id"],c["invocation_id"]); Ok(51)
    })["vars_patch"].clone();
    complete(&mut observed,&json!({"request_id":51,"ok":true,"value":{"operation_id":c["invocation_id"],"status":"queued"}}));
    assert_eq!(observed["surfaces"]["one"]["status"],"queued");
    let mut observed = on_action("observe-json",&Value::Null,&observed,&c,|_,_| Ok(52))["vars_patch"].clone();
    complete(&mut observed,&json!({"request_id":52,"ok":true,"value":{"operation_id":c["invocation_id"],"status":"rejected","reason":{"code":"variable_conflict","message":"revision changed"}}}));
    assert_eq!(observed["surfaces"]["one"]["status"],"conflict");
    assert_eq!(observed["surfaces"]["one"]["context"],original);
    assert_eq!(observed["surfaces"]["one"]["edit_id"],"editor-attempt-1");
    assert_eq!(observed["surfaces"]["one"]["detail"],"variable_conflict: revision changed");
}
#[test]
fn surfaces_mounts_receipts_and_tree_bindings_keep_exact_identity() {
    let mut a = ctx("a"); a["surface_generation"] = 1.into();
    let mut v = pending(&a);
    let b = ctx("b"); view::derive(&mut v,&b);
    assert_eq!(v["surface_views"][surface_key(&a)]["edit_state"]["status"],"saving");
    assert_eq!(v["surface_views"][surface_key(&b)]["edit_state"]["status"],"idle");
    a["surface_generation"] = 3.into();
    let mut v = render("sidebar",&v,&a,no_request)["vars_patch"].clone();
    assert_eq!(v["surfaces"]["a"]["status"],"unknown");
    complete(&mut v,&json!({"request_id":50,"ok":true,"value":{"operation_id":a["invocation_id"],"status":"applied"}}));
    assert_eq!(v["surfaces"]["a"]["status"],"unknown");
    let mut wrong = ctx("wrong"); wrong["surface_generation"] = 3.into();
    let denied = action(&snapshot(&wrong),&wrong,"save-json",save_payload(&snapshot(&a),&a,&json!({})));
    assert_eq!(denied["surfaces"]["wrong"]["status"],"error");
    for target in ["sidebar","expanded-page"] {
        let tree = view::tree(target,&surface_key(&a)).to_string();
        assert!(!tree.contains("textarea")); assert!(!tree.contains("review-save")); assert!(!tree.contains("New variable"));
        assert!(tree.contains("save-json")); assert!(tree.contains("observe-json")); assert!(tree.contains(&format!("surface_views.{}.edit_context",surface_key(&a))));
    }
}
#[test]
fn supported_targets_refresh_contexts_together_and_preserve_editor_fences() {
    let mut v = snapshot(&ctx("one"));
    for target in ["sidebar","expanded-page"] {
        let mut c = ctx(target); c["surface"]["target"] = target.into();
        view::derive(&mut v,&c);
    }
    inspect(&mut v,&inspection("8")).unwrap();
    view::derive(&mut v,&ctx("one"));
    for target in ["sidebar","expanded-page"] {
        let mut c = ctx(target); c["surface"]["target"] = target.into();
        assert_eq!(captured(&v,&c)["witness"],inspection("8")["witness"]);
        assert_eq!(captured(&v,&c)["target"],target);
        let other = if target == "sidebar" { "expanded-page" } else { "sidebar" };
        let mut wrong = c.clone(); wrong["surface"]["target"] = other.into();
        let out = action(&v,&wrong,"save-json",save_payload(&v,&c,&v["values"]));
        assert_eq!(out["surfaces"][target]["status"],"error");
    }
    // Keep the existing defensive block-write rejection independently from the
    // supported surface/context coverage above.
    let mut block = ctx("block-slot"); block["surface"]["target"] = "block-slot".into();
    view::derive(&mut v,&block);
    let out = action(&v,&block,"save-json",save_payload(&v,&block,&v["values"]));
    assert_eq!(out["surfaces"]["block-slot"]["status"],"error");
    let c = ctx("one");
    v["descriptors"]["owned"] = Value::Null;
    view::derive(&mut v,&c);
    let mut next = v["values"].clone(); next["owned"] = 9.into();
    let out = action(&v,&c,"save-json",save_payload(&v,&c,&next));
    assert_eq!(out["surfaces"]["one"]["status"],"error");
}

#[test]
fn unsupported_targets_are_empty_before_fences_mounts_reads_or_projection() {
    let mut c = ctx("one"); c["surface_generation"] = 1.into();
    let mut v = pending(&c);
    v["stale"] = true.into();
    v["inspection_request"] = 90.into();
    v["inspection_surface"] = "one".into();
    v["inspection_generation"] = 1.into();
    v["loading"] = true.into();
    let original = v.clone();
    for target in ["session-tab", "block-slot", "unknown", "", "Sidebar"] {
        let mut changed = c.clone();
        changed["surface_generation"] = 9.into();
        changed["surface"]["target"] = target.into();
        // An unchanged fence would reconcile pending work; a changed fence would
        // initialize new state. Neither may happen for unsupported output.
        for owner in ["owner", "different-owner"] {
            changed["owner_id"] = owner.into();
            let output = render(target, &v, &changed, no_request);
            assert_eq!(output, json!({"schema_version":1,"tree":null}));
            assert_eq!(output["tree"].to_string(), "null");
            assert!(output.get("vars_patch").is_none());
            assert!(output.get("error").is_none());
            assert_eq!(v, original);
        }
        assert_eq!(render(target, &Value::Null, &Value::Null, no_request), json!({"schema_version":1,"tree":null}));
        assert!(view::tree(target, "unused").is_null());
    }
}
#[test]
fn manifest_and_layouts_match_the_supported_inspection_surfaces() {
    assert_eq!(manifest()["targets"], json!(["sidebar", "expanded-page"]));
    let sidebar = view::tree("sidebar", "scope");
    let expanded = view::tree("expanded-page", "scope");
    assert_eq!(sidebar["children"][0]["type"], "input");
    assert_eq!(sidebar["children"][1]["type"], "row");
    assert_eq!(sidebar["children"][1]["children"].as_array().unwrap().len(), 2);
    assert_eq!(expanded["children"][0]["props"]["text"]["$ref"], "labels.description");
    assert_eq!(expanded["children"][1]["children"].as_array().unwrap().len(), 3);
    for tree in [&sidebar, &expanded] {
        let payload = tree["children"].as_array().unwrap().last().unwrap();
        assert_eq!(payload["type"], "payload");
        assert_eq!(payload["props"]["value"]["$ref"], "display_values");
        assert_eq!(payload["props"]["edit_value"]["$ref"], "values");
        assert_eq!(payload["props"]["edit_action"], "save-json");
        assert_eq!(payload["props"]["edit_validate_action"], "validate-json");
        assert_eq!(payload["props"]["edit_observe_action"], "observe-json");
    }
}

#[test]
fn applied_receipt_and_empty_snapshot_support_toolbar_editing() {
    let c = ctx("one"); let mut v = pending(&c);
    complete(&mut v,&json!({"request_id":50,"ok":true,"value":{"operation_id":c["invocation_id"],"status":"applied"}}));
    assert_eq!(v["surfaces"]["one"]["status"],"saved");
    let mut empty = inspection("2"); empty["values"] = json!({});
    inspect(&mut v,&empty).unwrap(); view::derive(&mut v,&c);
    assert_eq!(v["has_snapshot"],true); assert_eq!(v["has_values"],false);
    let tree = view::tree("sidebar",&surface_key(&c));
    assert!(tree.to_string().contains("\"visible\":{\"$ref\":\"has_snapshot\"}"));
}

#[test]
fn validation_reports_all_changed_readonly_keys_and_never_touches_operation_receipts() {
    let c = ctx("one");
    let mut v = pending(&c);
    complete(&mut v, &json!({"request_id":50,"ok":false,"error":"deadline"}));
    let receipt = v["surfaces"]["one"].clone();
    let base = captured(&v, &c);
    let mut next = base["values"].clone();
    next["framework"] = 2.into();
    next["init"] = 3.into();
    next.as_object_mut().unwrap().remove("delegated");
    let out = action(&v, &c, "validate-json", json!({"value":next.to_string(),"context":base,"validation_id":"validation-1"}));
    let validation = &out["surface_views"][surface_key(&c)]["edit_validation_state"];
    assert_eq!(validation["validation_id"], "validation-1");
    let errors = validation["diagnostics"].as_array().unwrap();
    assert_eq!(errors.len(), 3);
    for path in ["/framework", "/init", "/delegated"] {
        assert!(errors.iter().any(|d| d["path"] == path && d["severity"] == "error"));
    }
    assert_eq!(out["surfaces"]["one"], receipt);
    let valid = action(&out, &c, "validate-json", json!({"value":v["values"].to_string(),"context":captured(&v,&c),"validation_id":"validation-2"}));
    assert_eq!(valid["validations"]["one"]["diagnostics"], json!([]));
    assert_eq!(valid["surfaces"]["one"], receipt);
}

#[test]
fn validation_uses_captured_snapshot_and_exact_surface_history_fences() {
    let c = ctx("one");
    let v = snapshot(&c);
    let payload = json!({"value":v["values"].to_string(),"context":captured(&v,&c),"validation_id":"validation-1"});
    for field in ["history_generation", "instance_generation", "surface_generation"] {
        let mut changed = c.clone();
        changed[field] = 99.into();
        let out = action(&v, &changed, "validate-json", payload.clone());
        assert_eq!(out["validations"]["one"]["diagnostics"].as_array().unwrap().len(), 1);
    }
    let out = action(&snapshot(&ctx("other")), &ctx("other"), "validate-json", payload);
    assert_eq!(out["validations"]["other"]["diagnostics"].as_array().unwrap().len(), 1);
    let mut escaped = captured(&v, &c);
    escaped["values"]["a~/b"] = 1.into();
    let mut next = escaped["values"].clone();
    next["a~/b"] = 2.into();
    let out = action(&v, &c, "validate-json", json!({"value":next.to_string(),"context":escaped,"validation_id":"escaped"}));
    assert_eq!(out["validations"]["one"]["diagnostics"][0]["path"], "/a~0~1b");
}
