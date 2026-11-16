//! A second real Component for browser isolation, binding and input-pipeline tests.
//! It explicitly imports conversation decoration only; no State/network authority.
#![cfg(any(target_arch = "wasm32", test))]
use serde_json::{Value, json};
#[cfg(target_arch = "wasm32")]
mod bindings {
    use serde_json::json;
    wit_bindgen::generate!({ path: "../wit", world: "surface-fixture" });
    use microcrab::client_plugin::view_types::RenderMode;
    struct Component;
    impl Guest for Component {
        fn manifest() -> PluginManifest {
            PluginManifest {
                id: "microcrab.fixture".into(),
                name: "Component fixture".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                description: Some("A disabled-by-default real Component for runtime tests.".into()),
                targets: vec![
                    ViewTarget::Sidebar,
                    ViewTarget::ExpandedPage,
                    ViewTarget::SessionTab,
                    ViewTarget::BlockSlot,
                    ViewTarget::SettingPage,
                ],
                network_origins: None,
            }
        }
        fn init(_ctx: String) -> String {
            super::init().to_string()
        }
        fn render_view(_target: ViewTarget, vars: String, ctx: String) -> ViewOutput {
            let vars = super::decode(&vars);
            let ctx = super::decode(&ctx);
            let empty = vars["empty_view"].as_bool().unwrap_or(false);
            let html = !empty && vars["html_mode"].as_bool().unwrap_or(false);
            ViewOutput {
                schema_version: 1,
                mode: if html {
                    RenderMode::WebviewHtml
                } else {
                    RenderMode::NativeJson
                },
                content: if empty {
                    "null".into()
                } else if html {
                    serde_json::json!({"html":super::FIXTURE_HTML,"view_state":{"surface_id":ctx["surface_id"],"count":vars["count"]}}).to_string()
                } else {
                    super::render(&vars)["tree"].to_string()
                },
                vars_patch: Some(
                    serde_json::json!({"last_render_surface":ctx["surface_id"],"render_count":vars["render_count"].as_u64().unwrap_or(0)+1}).to_string(),
                ),
                rerender: false,
                error: (vars["render_error"] == true).then(|| "Fixture render rejected".into()),
            }
        }
        fn on_action(action: String, payload: String, vars: String, ctx: String) -> String {
            if action == "publish-slots" {
                let payload = super::decode(&payload);
                let slots = super::slots(&payload["block_id"], &super::decode(&vars));
                return match microcrab::client_plugin::conversation::request(
                    "block-slots",
                    &json!({"slots":slots}).to_string(),
                ) {
                    Ok(request_id) => {
                        json!({"schema_version":1,"vars_patch":{"slot_request":request_id}})
                            .to_string()
                    }
                    Err(error) => json!({"schema_version":1,"error":error}).to_string(),
                };
            }
            let mut result =
                super::action(&action, &super::decode(&payload), &super::decode(&vars));
            result["vars_patch"]["last_action_context"] = super::decode(&ctx);
            result.to_string()
        }
        fn on_phase(phase: String, payload: String, vars: String, _ctx: String) -> String {
            super::phase(&phase, &super::decode(&payload), &super::decode(&vars)).to_string()
        }
    }
    export!(Component);
}
#[cfg(target_arch = "wasm32")]
fn decode(input: &str) -> Value {
    serde_json::from_str(input).unwrap_or(Value::Null)
}
#[cfg(test)]
fn manifest() -> Value {
    json!({"schema_version":1,"id":"microcrab.fixture","name":"Component fixture","version":env!("CARGO_PKG_VERSION"),
        "description":"A disabled-by-default real Component for multi-plugin and deterministic input tests.","targets":["sidebar","expanded-page","session-tab","block-slot","setting-page"]})
}
fn init() -> Value {
    json!({"schema_version":1,"vars_patch":{"count":0,"label":"Fixture","prefix":"","reject":false,"inject_enabled":false,"fixture_value":null}})
}
fn render(_vars: &Value) -> Value {
    json!({"schema_version":1,"tree":{"type":"column","children":[
        {"type":"text","props":{"text":{"$ref":"label"}}},
        {"type":"text","props":{"text":{"$ref":"count"}}},
        {"type":"button","props":{"label":"Increment","action":"increment"}},
        {"type":"input","props":{"label":"Label","value":{"$ref":"label"},"change_action":"label"}},
        {"type":"button","props":{"label":"Use HTML","action":"html-mode","action_payload":{"value":true}}}
    ]}})
}
fn action(action: &str, payload: &Value, vars: &Value) -> Value {
    let patch = match action {
        "increment" => json!({"count":vars["count"].as_u64().unwrap_or(0).saturating_add(1)}),
        "label" => json!({"label":payload["value"].as_str().unwrap_or("")}),
        "html-mode" => json!({"html_mode":payload["value"].as_bool().unwrap_or(false)}),
        "prefix" => json!({"prefix":payload["value"].as_str().unwrap_or("")}),
        "reject" => json!({"reject":payload["value"].as_bool().unwrap_or(false)}),
        "inject" => json!({"inject_enabled":true,"fixture_value":payload["value"]}),
        "spin" => {
            // Only the browser Worker runs this deliberate non-returning action.
            // The runtime deadline must terminate that Worker; native tests never
            // spin, so their process cannot be stranded by fixture coverage.
            #[cfg(target_arch = "wasm32")]
            loop {
                core::hint::spin_loop();
            }
            #[cfg(not(target_arch = "wasm32"))]
            json!({})
        }
        _ => json!({}),
    };
    json!({"schema_version":1,"vars_patch":patch,"rerender":action == "html-mode" || (action == "increment" && vars["html_mode"] == true)})
}
const FIXTURE_HTML: &str = r#"<button id="fixture-action">Fixture HTML</button><button id="fixture-native">Use native</button><output id="fixture-count" aria-label="Fixture count"></output><script>
document.getElementById('fixture-action').addEventListener('click',()=>window.microcrab.action('increment',null));
document.getElementById('fixture-native').addEventListener('click',()=>window.microcrab.action('html-mode',{value:false}));
window.microcrab.onViewState(state=>{document.getElementById('fixture-count').textContent=String(state?.count??'');});
</script>"#;
fn slots(block_id: &Value, vars: &Value) -> Value {
    let Some(block_id) = block_id.as_str() else {
        return json!([]);
    };
    Value::Array(["before", "after"].into_iter().map(|placement| {
        if vars["html_mode"] == true {
            json!({"slot_id":format!("fixture-{placement}"),"block_id":block_id,"target":"block-slot","placement":placement,"mode":"webview-html","content":FIXTURE_HTML,"view_state":{"block_id":block_id,"placement":placement}})
        } else {
            json!({"slot_id":format!("fixture-{placement}"),"block_id":block_id,"target":"block-slot","placement":placement,"mode":"native-json","tree":{"type":"button","props":{"label":format!("Fixture {placement}"),"action":"increment"}}})
        }
    }).collect())
}
fn phase(phase: &str, payload: &Value, vars: &Value) -> Value {
    if phase == "settled-block" {
        return json!({"schema_version":1,"block_slots":slots(&payload["block_id"],vars)});
    }
    if phase == "settled-blocks" {
        let block_slots: Vec<Value> = payload["blocks"]
            .as_array()
            .into_iter()
            .flatten()
            .take(32)
            .flat_map(|block| {
                slots(&block["block_id"], vars)
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .collect();
        return json!({"schema_version":1,"block_slots":block_slots});
    }
    if phase == "before-submit" {
        if vars["reject"] == true {
            return json!({"schema_version":1,"error":"Fixture rejected input before submission"});
        }
        let mut result = json!({"schema_version":1,"rewritten_input":format!("{}{}",vars["prefix"].as_str().unwrap_or(""),payload["input"].as_str().unwrap_or(""))});
        if vars["inject_enabled"] == true {
            result["turn_variables"] = json!({"scoped_set":[{"name":"fixture_value","value":vars["fixture_value"],"visibility":"invisible","persistence":"ephemeral"}]});
        }
        return result;
    }
    json!({"schema_version":1})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settled_decorations_preserve_block_placement_and_safe_html_projection() {
        let native = phase(
            "settled-blocks",
            &json!({"blocks":[{"block_id":"block-a"}]}),
            &json!({}),
        );
        assert_eq!(native["block_slots"][0]["placement"], "before");
        assert_eq!(native["block_slots"][1]["placement"], "after");
        assert_eq!(native["block_slots"][0]["block_id"], "block-a");
        let html = phase(
            "settled-block",
            &json!({"block_id":"block-b"}),
            &json!({"html_mode":true,"secret":"never projected"}),
        );
        assert_eq!(html["block_slots"][0]["mode"], "webview-html");
        assert_eq!(
            html["block_slots"][0]["view_state"],
            json!({"block_id":"block-b","placement":"before"})
        );
        assert!(html["block_slots"][0].get("tree").is_none());
    }
    #[test]
    fn mode_switch_is_an_explicit_action_and_html_increment_refreshes_projection() {
        let rendered = render(&json!({}));
        assert_eq!(
            rendered["tree"]["children"][4]["props"]["label"],
            "Use HTML"
        );
        assert_eq!(
            rendered["tree"]["children"][4]["props"]["action_payload"],
            json!({"value":true})
        );
        let html = action("html-mode", &json!({"value":true}), &json!({}));
        assert_eq!(html["vars_patch"]["html_mode"], true);
        assert_eq!(html["rerender"], true);
        let native = action(
            "html-mode",
            &json!({"value":false}),
            &json!({"html_mode":true}),
        );
        assert_eq!(native["vars_patch"]["html_mode"], false);
        assert_eq!(native["rerender"], true);
        assert_eq!(
            action(
                "increment",
                &Value::Null,
                &json!({"count":2,"html_mode":true})
            )["rerender"],
            true
        );
        assert_eq!(
            action("increment", &Value::Null, &json!({"count":2}))["rerender"],
            false
        );
    }
    #[test]
    fn fixture_is_distinct_and_input_prefix_is_deterministic() {
        assert_eq!(manifest()["id"], "microcrab.fixture");
        let vars = json!({"prefix":"checked: ","count":4});
        assert_eq!(
            phase("before-submit", &json!({"input":"hello"}), &vars)["rewritten_input"],
            "checked: hello"
        );
        assert_eq!(
            action("increment", &Value::Null, &vars)["vars_patch"]["count"],
            5
        );
    }
    #[test]
    fn input_injection_is_explicit_invisible_and_ephemeral() {
        let vars =
            action("inject", &json!({"value":{"original":42}}), &json!({}))["vars_patch"].clone();
        let result = phase("before-submit", &json!({"input":"hello"}), &vars);
        assert_eq!(result["rewritten_input"], "hello");
        assert_eq!(
            result["turn_variables"]["scoped_set"][0],
            json!({"name":"fixture_value","value":{"original":42},"visibility":"invisible","persistence":"ephemeral"})
        );
    }
    #[test]
    fn rejected_preprocessing_returns_a_concrete_error_without_a_transformation() {
        let result = phase(
            "before-submit",
            &json!({"input":"original"}),
            &json!({"reject":true,"inject_enabled":true,"fixture_value":"secret"}),
        );
        assert_eq!(result["schema_version"], 1);
        assert_eq!(result["error"], "Fixture rejected input before submission");
        assert!(result.get("rewritten_input").is_none());
        assert!(result.get("turn_variables").is_none());
    }
    #[test]
    fn initial_values_satisfy_declared_tree_bindings_and_manifest_targets() {
        let manifest = manifest();
        assert_eq!(
            manifest["targets"],
            json!(["sidebar", "expanded-page", "session-tab", "block-slot", "setting-page"])
        );
        let initial = init();
        let vars = &initial["vars_patch"];
        assert_eq!(vars["count"], 0);
        assert_eq!(vars["reject"], false);
        assert_eq!(vars["inject_enabled"], false);
        let rendered = render(vars);
        for index in [0, 1] {
            let path = rendered["tree"]["children"][index]["props"]["text"]["$ref"]
                .as_str()
                .unwrap();
            assert!(vars.get(path).is_some());
        }
        assert_eq!(
            rendered["tree"]["children"][3]["props"]["change_action"],
            "label"
        );
        assert_eq!(
            phase("before-submit", &json!({"input":"original"}), vars)["rewritten_input"],
            "original"
        );
    }
}
