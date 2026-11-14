//! State inspection and checked editing belong to the guest. The host renders
//! generic nodes and stamps authority; no role or owner is accepted in writes.
#![cfg(any(target_arch = "wasm32", test))]
mod editor;
mod view;
use serde_json::{Map, Value, json};

#[cfg(target_arch = "wasm32")]
mod bindings {
    wit_bindgen::generate!({ path: "../wit", world: "state-viewer" });
    use serde_json::Value;
    struct Component;
    impl Guest for Component {
        fn manifest() -> PluginManifest {
            PluginManifest {
                id: "microcrab.state-viewer".into(),
                name: "State Viewer".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                description: super::manifest()["description"].as_str().map(str::to_owned),
                targets: vec![ViewTarget::Sidebar, ViewTarget::ExpandedPage],
                network_origins: None,
            }
        }
        fn init(ctx: String) -> String {
            super::init(&super::decode(&ctx)).to_string()
        }
        fn render_view(target: ViewTarget, vars: String, ctx: String) -> ViewOutput {
            let target = match target {
                ViewTarget::Sidebar => "sidebar",
                ViewTarget::ExpandedPage => "expanded-page",
                ViewTarget::SessionTab => "session-tab",
                ViewTarget::BlockSlot => "block-slot",
            };
            let output =
                super::render(target, &super::decode(&vars), &super::decode(&ctx), request);
            ViewOutput {
                schema_version: 1,
                mode: microcrab::client_plugin::view_types::RenderMode::NativeJson,
                // JSON null is intentional no-view within the mandatory envelope.
                // Error responses retain their error while clearing visual content.
                content: output
                    .get("tree")
                    .unwrap_or(&serde_json::Value::Null)
                    .to_string(),
                vars_patch: output.get("vars_patch").map(serde_json::Value::to_string),
                rerender: false,
                error: output["error"].as_str().map(str::to_owned),
            }
        }
        fn on_action(action: String, payload: String, vars: String, ctx: String) -> String {
            super::on_action(
                &action,
                &super::decode(&payload),
                &super::decode(&vars),
                &super::decode(&ctx),
                request,
            )
            .to_string()
        }
        fn on_phase(phase: String, payload: String, vars: String, ctx: String) -> String {
            super::on_phase(
                &phase,
                &super::decode(&payload),
                &super::decode(&vars),
                &super::decode(&ctx),
                request,
            )
            .to_string()
        }
    }
    fn request(kind: &str, payload: &Value) -> Result<u32, String> {
        if matches!(kind, "state-change" | "state-operation") {
            microcrab::client_plugin::session_state_write::request(kind, &payload.to_string())
        } else {
            microcrab::client_plugin::session_state::request(kind, &payload.to_string())
        }
    }
    export!(Component);
}
#[cfg(target_arch = "wasm32")]
fn decode(input: &str) -> Value {
    serde_json::from_str(input).unwrap_or(Value::Null)
}
fn manifest() -> Value {
    json!({"id":"microcrab.state-viewer","name":"State Viewer","version":env!("CARGO_PKG_VERSION"),
        "description":"Inspect and edit governed Session State. 查看和编辑受权限控制的会话状态。",
        "targets":["sidebar","expanded-page"]})
}
fn fence(ctx: &Value) -> Value {
    json!([
        ctx["server_origin"],
        ctx["owner_id"],
        ctx["session_id"],
        ctx["instance_generation"],
        ctx["history_generation"]
    ])
}
fn surface(ctx: &Value) -> &str {
    ctx["surface"]["surface_id"].as_str().unwrap_or("default")
}
fn surface_key(ctx: &Value) -> String {
    let mut key = String::from("s");
    for byte in surface(ctx).bytes() {
        key.push_str(&format!("{byte:02x}"));
    }
    key
}
fn init(ctx: &Value) -> Value {
    let mut vars = json!({"fence":fence(ctx),"search":"","show_invisible":false,"loading":false,"stale":true,
        "error":"","values":{},"metadata":{},"descriptors":{},"witness":null,"display_values":{},
        "has_snapshot":false,"inspection_request":null,"surfaces":{},"validations":{},"surface_views":{},"disabled":ctx["session_id"].is_null()});
    view::derive(&mut vars, ctx);
    result(vars)
}
fn result(vars: Value) -> Value {
    let output = json!({"schema_version":1,"vars_patch":vars});
    if output.to_string().len() > 16 * 1024 * 1024 - 64 * 1024 {
        return json!({"schema_version":1,"error":"State Viewer result exceeds the 16 MiB client JSON budget"});
    }
    output
}
fn current(vars: &Value, ctx: &Value) -> Value {
    let mut vars = if vars["fence"] == fence(ctx) {
        vars.clone()
    } else {
        init(ctx)["vars_patch"].clone()
    };
    // Hiding/unmounting fences host completions without undoing an admitted
    // mutation. A remount must retain its exact operation identity for explicit
    // observation, rather than leave the editor waiting for a revoked callback.
    if let (Some(sid), Some(generation)) = (
        ctx["surface"]["surface_id"].as_str(),
        ctx["surface_generation"].as_u64(),
    ) {
        let inspection_orphaned = vars["inspection_request"].is_number()
            && vars["inspection_surface"].as_str() == Some(sid)
            && vars["inspection_generation"].as_u64().unwrap_or(0) != generation;
        if inspection_orphaned {
            vars["inspection_request"] = Value::Null;
            vars["loading"] = false.into();
            vars["stale"] = true.into();
        }
        if let Some(e) = vars["surfaces"].get_mut(sid).filter(|e| e.is_object()) {
            let write_orphaned = e["pending"].is_number()
                && e["pending_generation"].as_u64().unwrap_or(0) != generation;
            let observe_orphaned = e["observe_request"].is_number()
                && e["observe_generation"].as_u64().unwrap_or(0) != generation;
            if write_orphaned || observe_orphaned {
                e["pending"] = Value::Null;
                e["observe_request"] = Value::Null;
                e["status"] = "unknown".into();
                e["review"] = Value::Null;
                e["detail"] = "Surface remounted; observe the retained operation before another save / 编辑面已重新挂载，请先观察保留的操作结果".into();
            }
        }
    }
    vars
}
fn visible(ctx: &Value) -> bool {
    ctx["target_visible"].as_bool().unwrap_or(true)
}
fn render(
    target: &str,
    vars: &Value,
    ctx: &Value,
    request: impl Fn(&str, &Value) -> Result<u32, String>,
) -> Value {
    // Unsupported targets are intentionally empty. Dispatch before current(),
    // which can reset fences or reconcile mount-owned requests and receipts.
    if !matches!(target, "sidebar" | "expanded-page") {
        return json!({"schema_version":1,"tree":null});
    }
    let mut vars = current(vars, ctx);
    // Only a render transfers a cross-surface read. Delayed old completions
    // must not steal ownership back and create an alternating request loop.
    // A surface-less phase read has a global callback lifetime and remains valid
    // when any mounted surface renders; only actual mount-owned reads transfer.
    if visible(ctx)
        && ctx["surface_generation"].is_number()
        && ctx["surface"]["surface_id"].is_string()
        && vars["inspection_request"].is_number()
        && vars["inspection_surface"].is_string()
        && vars["inspection_surface"] != ctx["surface"]["surface_id"]
    {
        vars["inspection_request"] = Value::Null;
        vars["loading"] = false.into();
        vars["stale"] = true.into();
    }
    if vars["stale"] == true && visible(ctx) {
        refresh(&mut vars, ctx, &request);
    }
    view::derive(&mut vars, ctx);
    let mut output = result(vars);
    if output.get("error").is_none() {
        output["tree"] = view::tree(target, &surface_key(ctx));
    }
    output
}
fn refresh(vars: &mut Value, ctx: &Value, request: &impl Fn(&str, &Value) -> Result<u32, String>) {
    if ctx["session_id"].is_null() || vars["loading"] == true {
        return;
    }
    vars["error"] = "".into();
    match request("state-inspection", &json!({})) {
        Ok(id) => {
            vars["inspection_request"] = id.into();
            vars["inspection_surface"] = ctx["surface"]["surface_id"].clone();
            vars["inspection_generation"] = ctx["surface_generation"].as_u64().unwrap_or(0).into();
            vars["loading"] = true.into();
            vars["stale"] = false.into();
        }
        Err(error) => fail(vars, &error),
    }
}
fn fail(vars: &mut Value, error: &str) {
    vars["error"] = error.into();
    vars["loading"] = false.into();
    vars["stale"] = true.into();
    vars["inspection_request"] = Value::Null;
}
fn valid_witness(w: &Value) -> bool {
    w["runtime_instance_id"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
        && w["variables_revision"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn inspect(vars: &mut Value, value: &Value) -> Result<(), String> {
    if !value["values"].is_object()
        || !value["metadata"].is_object()
        || !value["descriptors"].is_object()
        || !valid_witness(&value["witness"])
    {
        return Err(
            "State inspection requires atomic values, metadata, descriptors and a valid witness"
                .into(),
        );
    }
    if value["values"].to_string().len() > 4 * 1024 * 1024
        || value["metadata"].to_string().len() + value["descriptors"].to_string().len() > 512 * 1024
    {
        return Err("Session State snapshot exceeds the State Viewer display budget".into());
    }
    for key in ["values", "metadata", "descriptors", "witness"] {
        vars[key] = value[key].clone();
    }
    vars["has_snapshot"] = true.into();
    vars["loading"] = false.into();
    vars["inspection_request"] = Value::Null;
    Ok(())
}
// Descriptors certify custom-variable rights; metadata presence alone never does.
fn rights(vars: &Value, name: &str) -> (bool, bool, bool) {
    let d = &vars["descriptors"][name];
    let custom = d["kind"] == "custom";
    let owner = vars["metadata"][name]["owner"] == "client";
    (
        custom && d["editable"] == true,
        custom && owner && d["owner_editable"] == true,
        custom && owner && d["deletable"] == true,
    )
}
fn on_action(
    action: &str,
    payload: &Value,
    vars: &Value,
    ctx: &Value,
    request: impl Fn(&str, &Value) -> Result<u32, String>,
) -> Value {
    let mut vars = current(vars, ctx);
    match action {
        "toggle-invisible" => {
            vars["show_invisible"] = (!vars["show_invisible"].as_bool().unwrap_or(false)).into()
        }
        "search" => vars["search"] = payload["value"].as_str().unwrap_or("").into(),
        "clear-search" => vars["search"] = "".into(),
        "refresh" => refresh(&mut vars, ctx, &request),
        _ => editor::action(action, payload, &mut vars, ctx, &request),
    }
    view::derive(&mut vars, ctx);
    result(vars)
}
fn complete(vars: &mut Value, payload: &Value) {
    let Some(id) = payload["request_id"].as_u64() else {
        return;
    };
    if vars["inspection_request"].as_u64() == Some(id) {
        if payload["ok"] != true {
            fail(
                vars,
                payload["error"]
                    .as_str()
                    .unwrap_or("State inspection failed"),
            );
        } else if let Err(error) = inspect(vars, &payload["value"]) {
            fail(vars, &error);
        }
        return;
    }
    let mut refresh_needed = false;
    if let Some(surfaces) = vars["surfaces"].as_object_mut() {
        for e in surfaces.values_mut().filter(|e| e.is_object()) {
            let write = e["pending"].as_u64() == Some(id);
            let observe = e["observe_request"].as_u64() == Some(id);
            if !write && !observe {
                continue;
            }
            e[if write { "pending" } else { "observe_request" }] = Value::Null;
            if payload["ok"] != true {
                // A transport failure cannot certify rejection. Preserve the draft,
                // retain exact operation identity and never resubmit automatically.
                e["status"] = "unknown".into();
                e["detail"] = payload["error"]
                    .as_str()
                    .unwrap_or("Write outcome is unknown / 写入结果未知")
                    .into();
            } else {
                let response = &payload["value"];
                if response["operation_id"] != e["operation_id"] {
                    e["status"] = "unknown".into();
                    e["detail"] = "Operation identity mismatch / 操作标识不匹配".into();
                    continue;
                }
                let status = response["status"].as_str().unwrap_or("unknown");
                e["status"] = match status {
                    "applied" => "saved",
                    "rejected"
                        if response["reason"]["code"] == "variable_conflict"
                            || response["reason"]
                                .as_str()
                                .is_some_and(|s| s.contains("variable_conflict")) =>
                    {
                        "conflict"
                    }
                    "rejected" => "error",
                    "queued" => "queued",
                    _ => "unknown",
                }
                .into();
                e["detail"] = if let Some(reason) = response["reason"].as_str() {
                    reason.to_owned()
                } else if let Some(message) = response["reason"]["message"].as_str() {
                    format!(
                        "{}: {message}",
                        response["reason"]["code"].as_str().unwrap_or("rejected")
                    )
                } else {
                    String::new()
                }
                .into();
                e["conflict"] = (response["reason"]["code"] == "variable_conflict"
                    || response["reason"]
                        .as_str()
                        .is_some_and(|s| s.contains("variable_conflict")))
                .into();
                e["review"] = Value::Null;
                if status == "applied" {
                    e["dirty"] = false.into();
                }
                refresh_needed = true;
            }
        }
    }
    if refresh_needed {
        vars["stale"] = true.into();
    }
}
fn on_phase(
    phase: &str,
    payload: &Value,
    vars: &Value,
    ctx: &Value,
    request: impl Fn(&str, &Value) -> Result<u32, String>,
) -> Value {
    let mut vars = current(vars, ctx);
    match phase {
        "event-result" => complete(&mut vars, payload),
        "session-change" | "history-reset" => vars = init(ctx)["vars_patch"].clone(),
        "runtime-event" => vars["stale"] = true.into(),
        _ => (),
    }
    if vars["stale"] == true && vars["error"] == "" && visible(ctx) {
        refresh(&mut vars, ctx, &request);
    }
    view::derive(&mut vars, ctx);
    result(vars)
}
#[cfg(test)]
mod tests;
