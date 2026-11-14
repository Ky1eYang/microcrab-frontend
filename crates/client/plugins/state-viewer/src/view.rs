//! Pure projection and declarative schema, independent of the browser host.
use super::*;

pub(super) fn derive(vars: &mut Value, ctx: &Value) {
    let zh = !ctx["locale"].as_str().unwrap_or("zh-CN").starts_with("en");
    let words = if zh {
        json!({"title":"会话状态","description":"查看会话的原始状态和属性。不可见仅针对模型，用户可通过眼睛按钮在本地显示原始值。",
            "search":"搜索名称或值","clear_search":"清除搜索","refresh":"刷新","show":"显示模型不可见的值（当前隐藏，点击显示）","hide":"隐藏模型不可见的值（当前显示，点击隐藏）",
            "loading":"正在读取状态…","refreshing":"正在更新状态，当前显示上次完整结果…","stale":"状态已更改，请刷新。",
            "empty":"当前会话尚无状态字段。可点击刷新重新读取完整会话状态。",
            "no_matches":"未找到匹配的状态字段。清除搜索以查看其他字段。",
            "hidden_only":"当前字段均对模型不可见，点击眼睛按钮可在本地显示原始值。","disabled":"请先选择会话。"})
    } else {
        json!({"title":"Session State","description":"Inspect original Session State values and attributes. Invisible means hidden from the model only. Use the eye button to reveal original values locally.",
            "search":"Search names or values","clear_search":"Clear search","refresh":"Refresh","show":"Show model-invisible values (currently hidden, click to reveal)","hide":"Hide model-invisible values (currently revealed, click to hide)",
            "loading":"Loading State…","refreshing":"Updating State; showing the last complete result…","stale":"State changed. Refresh to update.",
            "empty":"This Session has no State fields yet. Refresh to read the complete Session State again.",
            "no_matches":"No matching State fields. Clear search to inspect other fields.",
            "hidden_only":"All current fields are hidden from the model. Use the eye button to reveal original values locally.","disabled":"Select a Session first."})
    };
    let show = vars["show_invisible"] == true;
    let query = vars["search"].as_str().unwrap_or("").to_lowercase();
    let mut displayed = Map::new();
    let mut eligible = 0;
    if let Some(values) = vars["values"].as_object() {
        for (key, value) in values {
            let attrs = &vars["metadata"][key];
            let invisible = attrs["visibility"] == "invisible";
            if invisible && !show {
                continue;
            }
            eligible += 1;
            if !query.is_empty()
                && !key.to_lowercase().contains(&query)
                && !value.to_string().to_lowercase().contains(&query)
            {
                continue;
            }
            displayed.insert(key.clone(), value.clone());
        }
    }
    let has_snapshot = vars["has_snapshot"] == true && vars["disabled"] != true;
    let empty =
        has_snapshot && displayed.is_empty() && vars["loading"] != true && vars["error"] == "";
    vars["empty"] = empty.into();
    vars["has_values"] = (has_snapshot && !displayed.is_empty()).into();
    vars["has_search"] = (!query.is_empty()).into();
    vars["initial_loading"] = (vars["loading"] == true && !has_snapshot).into();
    vars["refreshing"] = (vars["loading"] == true && has_snapshot).into();
    let no_fields = vars["values"].as_object().is_none_or(Map::is_empty);
    vars["empty_message"] = words[if no_fields {
        "empty"
    } else if eligible == 0 {
        "hidden_only"
    } else {
        "no_matches"
    }]
    .clone();
    vars["display_values"] = Value::Object(displayed);
    vars["has_error"] = (!vars["error"].as_str().unwrap_or("").is_empty()).into();
    vars["stale_notice"] =
        (vars["stale"] == true && vars["loading"] != true && vars["disabled"] != true).into();
    vars["eye_label"] = words[if show { "hide" } else { "show" }].clone();
    vars["eye_icon"] = (if show { "eye-off" } else { "eye" }).into();
    vars["eye_pressed"] = show.into();
    // Each tree binds its own scope. Open host editors retain their captured copy.
    let key = surface_key(ctx);
    let captured = editor::context(vars, ctx);
    vars["surface_views"][&key] = json!({"edit_context":captured,"edit_state":{}});
    let projections = vars["surface_views"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (key, projection) in projections {
        let mut captured = projection["edit_context"].clone();
        for field in ["values", "metadata", "descriptors", "witness"] {
            captured[field] = vars[field].clone();
        }
        let sid = captured["surface_id"].as_str().unwrap_or("");
        let state = vars["surfaces"][sid].clone();
        let state = if state.is_object() {
            state
        } else {
            json!({"status":"idle","detail":"","operation_id":"","edit_id":""})
        };
        let validation = vars["validations"][sid].clone();
        vars["surface_views"][&key] =
            json!({"edit_context":captured,"edit_state":state,"edit_validation_state":validation});
    }
    let readonly: Vec<_> = vars["values"]
        .as_object()
        .into_iter()
        .flat_map(|values| values.keys())
        .filter(|key| !rights(vars, key).0)
        .cloned()
        .collect();
    let shown = readonly
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    vars["edit_notice"] = if zh {
        format!("编辑完整快照（含隐藏和筛选外字段）。只读字段保持原值；仅客户端所有的字段可删除。新增变量默认模型可见、持久保存，所有角色可编辑。只读字段 {} 项{}{}", readonly.len(), if shown.is_empty() { "" } else { "：" }, shown)
    } else {
        format!("Editing the full snapshot, including hidden and filtered fields. Keep read-only values unchanged; only Client-owned fields can be removed. New variables are visible, persisted and editable by all roles. {} read-only fields{}{}", readonly.len(), if shown.is_empty() { "" } else { ": " }, shown)
    }.into();
    vars["labels"] = words;
}
fn bound(path: &str) -> Value {
    json!({"$ref":path})
}
fn text(path: &str) -> Value {
    json!({"type":"text","props":{"text":bound(path)}})
}
fn conditional(path: &str, child: Value) -> Value {
    json!({"type":"conditional","props":{"test":bound(path)},"children":[child]})
}
pub(super) fn tree(target: &str, surface_key: &str) -> Value {
    // Keep this pure projection defensive as well as the render entry point.
    if !matches!(target, "sidebar" | "expanded-page") {
        return Value::Null;
    }
    let search = json!({"type":"input","props":{"value":bound("search"),"placeholder":bound("labels.search"),"input_type":"search","change_action":"search","clear_action":"clear-search","clear_label":bound("labels.clear_search")}});
    let eye = json!({"type":"button","props":{"label":bound("eye_label"),"icon":bound("eye_icon"),"pressed":bound("eye_pressed"),"action":"toggle-invisible"}});
    let refresh = json!({"type":"button","props":{"label":bound("labels.refresh"),"icon":"refresh","action":"refresh","disabled":bound("loading")}});
    let mut children = match target {
        // The rail already supplies the plugin title. Give search the full narrow
        // width instead of squeezing it beside two inspection controls.
        "sidebar" => vec![search, json!({"type":"row","children":[eye,refresh]})],
        // Expand/direct URL retain full inspection with concise guidance and a
        // single horizontal toolbar in the larger presentation.
        "expanded-page" => vec![
            text("labels.description"),
            json!({"type":"row","children":[search,eye,refresh]}),
        ],
        _ => return Value::Null,
    };
    children.extend([
        conditional("disabled", text("labels.disabled")),
        conditional("initial_loading", text("labels.loading")),
        conditional("refreshing", text("labels.refreshing")),
        conditional(
            "stale_notice",
            json!({"type":"notice","props":{"text":bound("labels.stale"),"tone":"info"}}),
        ),
        conditional(
            "has_error",
            json!({"type":"notice","props":{"text":bound("error"),"tone":"error"}}),
        ),
        conditional("empty", text("empty_message")),
        // Keep Payload a direct flex child, with only a complete filtered map.
        payload(surface_key),
    ]);
    json!({"type":"column","id":format!("state-viewer-{target}"),"children":children})
}
fn payload(key: &str) -> Value {
    json!({"type":"payload","props":{
        "allowed_formats":["json","raw"],"value":bound("display_values"),"visible":bound("has_snapshot"),
        "edit_notice":bound("edit_notice"),"edit_validate_action":"validate-json",
        "edit_validation_state":bound(&format!("surface_views.{key}.edit_validation_state")),
        "edit_action":"save-json","edit_value":bound("values"),
        "edit_context":bound(&format!("surface_views.{key}.edit_context")),
        "edit_state":bound(&format!("surface_views.{key}.edit_state")),"edit_observe_action":"observe-json"
    }})
}
