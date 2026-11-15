use super::*;

#[test]
fn legacy_and_retained_short_calls_validate_exact_config_and_schema() {
    let identity = json!({"session_id":"s"});
    let mut pins = call_pins::CallPins::default();
    let mut cursors = discovery::Cursors::default();
    let mut op = Operation::new(
        json!({"action":"describe","server":"a","tool":"tool-0"}),
        json!({"tool_invocation":identity}),
    );
    op.resource = resources()[0].clone();
    op.tools = tools(1);
    let out = output(&op, &mut pins, &mut cursors);
    let full_schema = pin(&op.tools[0]["inputSchema"]);
    for (config, schema) in [
        (op.resource["config_pin"].clone(), json!(full_schema)),
        (out["config_pin"].clone(), out["schema_pin"].clone()),
    ] {
        op.request = json!({"action":"call","server":"a","tool":"tool-0","config_pin":config,"schema_pin":schema,"arguments":{}});
        pins.expand_request(&identity, &mut op.request).unwrap();
        assert_eq!(op.request["config_pin"], op.resource["config_pin"]);
        assert_eq!(op.request["schema_pin"], full_schema);
        assert!(op.call_params().is_ok());
        let old = op.resource["config_pin"].clone();
        op.resource["config_pin"] = json!("new-live-revision");
        assert!(op.call_params().unwrap_err().contains("changed"));
        op.resource["config_pin"] = old;
        op.tools[0]["inputSchema"]["required"] = json!(["new"]);
        assert!(op.call_params().unwrap_err().contains("changed"));
        op.tools[0]["inputSchema"] = json!({"type":"object"});
    }
    op.request = json!({"action":"call","pin":out["call_pin"],"server":"wrong"});
    assert!(
        pins.expand_request(&identity, &mut op.request)
            .unwrap_err()
            .contains("conflicts")
    );
    let mut changed = identity.clone();
    changed["history_generation"] = json!(99);
    op.request = json!({"action":"call","server":"a","tool":"tool-0","config_pin":out["config_pin"],"schema_pin":out["schema_pin"]});
    assert!(pins.expand_request(&changed, &mut op.request).is_err());
    assert!(
        call_pins::CallPins::default()
            .expand_request(&identity, &mut op.request)
            .is_err()
    );
    op.request = json!({"action":"call","server":"a","tool":"tool-0","config_pin":"1234567890123456","schema_pin":full_schema});
    assert!(
        call_pins::CallPins::default()
            .expand_request(&identity, &mut op.request)
            .is_ok()
    );
    op.resource["config_pin"] = json!("1234567890123456");
    assert!(op.call_params().is_ok());
}
#[test]
fn remote_discovery_limits_remain_per_catalog() {
    let mut op = Operation::new(json!({}), json!({}));
    for n in 0..99 {
        assert!(
            op.admit_page(&json!({"tools":[],"nextCursor":format!("p-{n}")}))
                .is_ok()
        );
    }
    assert!(
        op.admit_page(&json!({"tools":[],"nextCursor":"p-100"}))
            .is_err()
    );
    op.begin_catalog(resources()[0].clone());
    assert!(op.admit_page(&json!({"tools":tools(1000)})).is_ok());
    assert!(
        op.admit_page(&json!({"tools":[{"name":"extra","inputSchema":{"type":"object"}}]}))
            .unwrap_err()
            .contains("1000")
    );
    op.begin_catalog(resources()[1].clone());
    assert_eq!(op.pages, 0);
    assert!(op.tools.is_empty());
    assert!(op.admit_page(&json!({"tools":[{"name":"oversized","description":"x".repeat(2*1024*1024),"inputSchema":{"type":"object"}}]})).unwrap_err().contains("2 MiB"));
}

fn resources() -> Vec<Value> {
    ["a", "b", "empty", "failed"]
        .into_iter()
        .map(|id| json!({"id":id,"config_pin":format!("full-revision-{id}"),"enabled":true}))
        .collect()
}
fn tools(count: usize) -> Vec<Value> {
    (0..count).map(|n| json!({"name":format!("tool-{n}"),"description":"x".repeat(900),"inputSchema":{"type":"object"}})).collect()
}
fn aggregate(request: Value, identity: &Value, cursors: &discovery::Cursors) -> Operation {
    let mut op = Operation::new(request, json!({"tool_invocation":identity}));
    op.aggregate = true;
    op.resources = resources();
    op.offset = cursors
        .start(identity, &op.request, &discovery::inventory(&op.resources))
        .unwrap();
    for (resource, count, error) in [
        (op.resources[0].clone(), 23, None),
        (op.resources[1].clone(), 19, None),
        (op.resources[2].clone(), 0, None),
        (
            op.resources[3].clone(),
            0,
            Some("MCP server rejected the JSON-RPC request"),
        ),
    ] {
        op.begin_catalog(resource);
        op.admit_page(&json!({"tools":tools(count)})).unwrap();
        op.retain_server(error);
        assert!(op.tools.is_empty());
        assert!(
            op.servers
                .iter()
                .map(|s| s["tools"].as_array().unwrap().len())
                .sum::<usize>()
                <= discovery::limit(&op.request)
        );
    }
    op
}
fn output(
    op: &Operation,
    pins: &mut call_pins::CallPins,
    cursors: &mut discovery::Cursors,
) -> Value {
    let reply = op.discovery(pins, cursors);
    assert_eq!(reply["tool_completion"]["status"], "completed", "{reply}");
    reply["tool_completion"]["output"].clone()
}
fn is_short(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 16
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
#[test]
fn aggregate_pages_keep_every_tool_and_explicit_empty_and_failed_servers() {
    for limit in [1, 7, 20, 32, 99] {
        let identity = json!({"session_id":"one","artifact":"full-artifact","epoch":1});
        let mut pins = call_pins::CallPins::default();
        let mut cursors = discovery::Cursors::default();
        let mut request = json!({"action":"list","limit":limit});
        let mut found = Vec::new();
        let mut non_tools = Vec::new();
        let mut pages = 0;
        loop {
            let op = aggregate(request.clone(), &identity, &cursors);
            let out = output(&op, &mut pins, &mut cursors);
            let servers = out["servers"].as_array().unwrap();
            assert!(
                servers
                    .iter()
                    .map(|s| s["tools"].as_array().unwrap().len())
                    .sum::<usize>()
                    <= limit.min(32)
            );
            for server in servers {
                assert!(is_short(&server["config_pin"]));
                let tools = server["tools"].as_array().unwrap();
                if tools.is_empty() {
                    non_tools.push(server.clone());
                }
                for tool in tools {
                    assert!(tool["description"].as_str().unwrap().len() <= 512);
                    found.push((server["id"].clone(), tool["name"].clone()));
                }
            }
            pages += 1;
            assert!(pages <= 44);
            if out["next_cursor"].is_null() {
                break;
            }
            assert!(is_short(&out["next_cursor"]));
            request["cursor"] = out["next_cursor"].clone();
        }
        let expected: Vec<_> = [("a", 23), ("b", 19)]
            .into_iter()
            .flat_map(|(s, n)| (0..n).map(move |i| (json!(s), json!(format!("tool-{i}")))))
            .collect();
        assert_eq!(found, expected);
        assert_eq!(non_tools.len(), 2);
        assert_eq!(non_tools[0]["id"], "empty");
        assert!(non_tools[0].get("error").is_none());
        assert_eq!(non_tools[1]["id"], "failed");
        assert!(non_tools[1]["error"].is_string());
    }
}
#[test]
fn default_limit_and_graceful_describe_are_consistent() {
    let mut pins = call_pins::CallPins::default();
    let mut cursors = discovery::Cursors::default();
    let identity = json!({"session_id":"s"});
    let op = aggregate(json!({"action":"list"}), &identity, &cursors);
    let out = output(&op, &mut pins, &mut cursors);
    assert_eq!(out["servers"][0]["tools"].as_array().unwrap().len(), 20);
    let mut op = Operation::new(
        json!({"action":"describe","server":"a"}),
        json!({"tool_invocation":identity}),
    );
    op.resource = resources()[0].clone();
    op.tools = tools(23);
    let out = output(&op, &mut pins, &mut cursors);
    assert_eq!(out["tools"].as_array().unwrap().len(), 20);
    assert!(
        is_short(&out["config_pin"])
            && is_short(&out["catalog_pin"])
            && is_short(&out["next_cursor"])
    );
    assert!(out["usage_hint"].as_str().unwrap().contains("describe"));
    op.request["cursor"] = out["next_cursor"].clone();
    let remaining = output(&op, &mut pins, &mut cursors);
    assert_eq!(remaining["tools"].as_array().unwrap().len(), 3);
    assert_eq!(remaining["tools"][0]["name"], "tool-20");
    assert!(remaining["next_cursor"].is_null());
    op.request = json!({"action":"describe","server":"a","tool":"tool-0"});
    let out = output(&op, &mut pins, &mut cursors);
    assert!(
        is_short(&out["schema_pin"]) && is_short(&out["config_pin"]) && is_short(&out["call_pin"])
    );
    let target = pins
        .resolve(&identity, out["call_pin"].as_str().unwrap())
        .unwrap();
    assert_eq!(target.config_pin, "full-revision-a");
    assert_eq!(target.schema_pin, pin(&json!({"type":"object"})));
    op.request = json!({"action":"call","pin":out["call_pin"],"arguments":{}});
    pins.expand_request(&identity, &mut op.request).unwrap();
    assert_eq!(op.request["schema_pin"], target.schema_pin);
    assert_eq!(op.request["config_pin"], target.config_pin);
    let payload = op.http_payload(json!({}), false);
    assert_eq!(payload["config_pin"], "full-revision-a");
}
#[test]
fn cursor_checks_full_config_catalog_scope_and_worker_retention() {
    let mut pins = call_pins::CallPins::default();
    let mut cursors = discovery::Cursors::default();
    let identity = json!({"session_id":"one"});
    let op = aggregate(json!({"action":"list","limit":1}), &identity, &cursors);
    let out = output(&op, &mut pins, &mut cursors);
    let token = out["next_cursor"].as_str().unwrap();
    let inventory = discovery::inventory(&op.resources);
    for field in [
        "session_id",
        "parent_session_id",
        "artifact",
        "generation",
        "history_generation",
        "epoch",
        "catalog_digest",
    ] {
        let mut changed = identity.clone();
        changed[field] = json!("changed");
        assert!(
            cursors.check(&changed, token, &inventory).is_err(),
            "{field}"
        );
    }
    let mut changed = op.resources.clone();
    changed[0]["config_pin"] = json!("different-full-revision");
    assert!(
        cursors
            .check(&identity, token, &discovery::inventory(&changed))
            .is_err()
    );
    assert!(
        discovery::Cursors::default()
            .check(&identity, token, &inventory)
            .is_err()
    );
    let request = json!({"action":"list","cursor":token,"limit":1});
    let mut op = aggregate(request, &identity, &cursors);
    op.servers[1]["catalog_pin"] = json!("changed-full-catalog-pin");
    assert_eq!(
        op.discovery(&mut pins, &mut cursors)["tool_completion"]["status"],
        "failed"
    );
    assert!(
        cursors
            .start(&identity, &json!({"cursor":{"offset":1}}), &inventory)
            .is_err()
    );
    assert!(
        cursors
            .check(&identity, "{\"offset\":1}", &inventory)
            .is_err()
    );
}
#[test]
fn aggregate_fingerprints_include_schema_and_errors_beyond_current_page() {
    let identity = json!({"session_id":"s"});
    let mut pins = call_pins::CallPins::default();
    let mut cursors = discovery::Cursors::default();
    let op = aggregate(json!({"action":"list","limit":1}), &identity, &cursors);
    let first = output(&op, &mut pins, &mut cursors);
    let request = json!({"action":"list","limit":1,"cursor":first["next_cursor"]});
    let mut changed = aggregate(request.clone(), &identity, &cursors);
    changed.servers[3]["error"] = json!("different discovery error");
    assert_eq!(
        changed.discovery(&mut pins, &mut cursors)["tool_completion"]["status"],
        "failed"
    );
    let mut changed = aggregate(request, &identity, &cursors);
    changed.servers[1]["catalog_pin"] =
        pin(&json!({"type":"object","required":["changed"]})).into();
    assert_eq!(
        changed.discovery(&mut pins, &mut cursors)["tool_completion"]["status"],
        "failed"
    );
}
#[test]
fn empty_aggregate_and_all_failed_catalogs_terminate_without_fake_tools() {
    let mut cursors = discovery::Cursors::default();
    let mut pins = call_pins::CallPins::default();
    let mut op = Operation::new(json!({"action":"list"}), json!({}));
    op.aggregate = true;
    let out = output(&op, &mut pins, &mut cursors);
    assert_eq!(out["servers"], json!([]));
    assert!(out["next_cursor"].is_null());
    op.resources = resources();
    for r in op.resources.clone() {
        op.begin_catalog(r);
        op.retain_server(Some("MCP HTTP request failed"));
    }
    let out = output(&op, &mut pins, &mut cursors);
    assert_eq!(out["servers"].as_array().unwrap().len(), 4);
    assert!(out["next_cursor"].is_null());
    assert!(
        out["servers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["error"].is_string() && s["tools"] == json!([]))
    );
}
