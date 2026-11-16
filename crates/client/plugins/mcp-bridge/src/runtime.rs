use super::*;
use std::{cell::RefCell, collections::BTreeMap};
wit_bindgen::generate!({ path: "../wit", world: "tool-plugin" });
use microcrab::client_plugin::{net, resources, view_types::RenderMode};
thread_local! {
    static CURSORS: RefCell<discovery::Cursors> = RefCell::new(discovery::Cursors::default());
    static CALL_PINS: RefCell<call_pins::CallPins> = RefCell::new(call_pins::CallPins::default());
    static PENDING: RefCell<BTreeMap<u32, Operation>> = const { RefCell::new(BTreeMap::new()) };
    static CONFIG_REQUESTS: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static SEQUENCE: RefCell<u64> = const { RefCell::new(0) };
}
fn empty() -> Value {
    json!({"schema_version":1})
}
fn issue(mut op: Operation, method: &str, params: Value) -> Value {
    let sequence = SEQUENCE.with(|s| {
        let mut s = s.borrow_mut();
        *s = s.saturating_add(1);
        *s
    });
    let body = op.rpc_body(sequence, method, params);
    let payload = op.http_payload(body, false);
    queue_http(op, payload)
}
fn queue_http(op: Operation, payload: Value) -> Value {
    match net::request("http", &payload.to_string()) {
        Ok(id) => {
            let pending = reply(&op.identity, "pending", Value::Null, None, false);
            PENDING.with(|p| p.borrow_mut().insert(id, op));
            pending
        }
        Err(_) => failure(op, "MCP network request could not be queued", false),
    }
}
fn config_request(kind: &str, payload: Value) -> Value {
    match resources::request(kind, &payload.to_string()) {
        Ok(id) => {
            CONFIG_REQUESTS.with(|p| p.borrow_mut().push(id));
            empty()
        }
        Err(_) => {
            json!({"schema_version":1,"vars_patch":{"status":"Configuration request failed"}})
        }
    }
}
fn safe_servers(value: &Value) -> Value {
    Value::Array(value.as_array().into_iter().flatten().map(|c| json!({"id":c["id"],"origin":c["origin"],"enabled":c["enabled"],"config_pin":c["config_pin"],"requires_reenable":c["requires_reenable"]})).collect())
}
fn discovery_complete(op: Operation) -> Value {
    CALL_PINS.with(|pins| {
        CURSORS.with(|cursors| op.discovery(&mut pins.borrow_mut(), &mut cursors.borrow_mut()))
    })
}
fn initialize(op: Operation) -> Value {
    issue(
        op,
        "initialize",
        json!({"protocolVersion":VERSIONS[0],"capabilities":{},"clientInfo":{"name":"microcrab-mcp-bridge","version":env!("CARGO_PKG_VERSION")}}),
    )
}
fn next_server(mut op: Operation, error: Option<&str>) -> Value {
    op.retain_server(error);
    if let Some(resource) = op.resources.get(op.servers.len()).cloned() {
        op.begin_catalog(resource);
        initialize(op)
    } else {
        discovery_complete(op)
    }
}
fn failure(op: Operation, error: &str, unknown: bool) -> Value {
    if op.aggregate && !matches!(op.stage, Stage::Resources | Stage::Call) && !unknown {
        next_server(op, Some(error))
    } else {
        op.fail(error, unknown)
    }
}
fn advance(mut op: Operation, event: &Value) -> Value {
    if event["ok"] != true {
        let unknown = matches!(op.stage, Stage::Call);
        let error_msg = event
            .get("error")
            .and_then(|e| e.as_str())
            .filter(|s| !s.is_empty());
        let msg = match error_msg {
            Some(e) => format!("MCP transport failed: {e}"),
            None => "MCP transport failed or was cancelled; check CORS, mixed-content policy and server connectivity".into(),
        };
        return failure(op, &msg, unknown);
    }
    let value = &event["value"];
    match op.stage {
        Stage::Resources => {
            if !value.is_array() {
                return op.fail("Invalid configured resource inventory", false);
            }
            if value.as_array().is_none_or(|r| r.len() > 32) {
                return op.fail("Configured resource inventory exceeds 32 servers", false);
            }
            if op.request["action"] == "list" && op.request.get("server").is_none() {
                op.aggregate = true;
                op.resources = value
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|s| s["enabled"] == true)
                    .cloned()
                    .collect();
                op.resources
                    .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
                op.offset = match CURSORS.with(|c| {
                    c.borrow().start(
                        &op.identity,
                        &op.request,
                        &discovery::inventory(&op.resources),
                    )
                }) {
                    Ok(offset) => offset,
                    Err(error) => return op.fail(error, false),
                };
                let Some(resource) = op.resources.first().cloned() else {
                    return discovery_complete(op);
                };
                op.begin_catalog(resource);
                return initialize(op);
            }
            if op.request["action"] == "call" {
                if let Err(error) = CALL_PINS
                    .with(|pins| pins.borrow().expand_request(&op.identity, &mut op.request))
                {
                    return op.fail(error, false);
                }
            }
            let Some(resource) = value
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| c["id"] == op.request["server"] && c["enabled"] == true)
            else {
                return op.fail("Exact MCP server is missing or disabled", false);
            };
            if op
                .request
                .get("config_pin")
                .is_some_and(|p| p != &resource["config_pin"])
            {
                return op.fail(
                    "MCP server configuration changed; describe the tool again",
                    false,
                );
            }
            if op.request["action"] != "call" {
                if let Err(error) = CURSORS.with(|c| {
                    c.borrow().start(
                        &op.identity,
                        &op.request,
                        &discovery::inventory(std::slice::from_ref(resource)),
                    )
                }) {
                    return op.fail(error, false);
                }
            }
            op.begin_catalog(resource.clone());
            initialize(op)
        }
        Stage::Initialize => {
            let result = match op.rpc_result(value) {
                Ok(v) => v,
                Err((e, u)) => return failure(op, &e, u),
            };
            let Some(version) = result["protocolVersion"]
                .as_str()
                .filter(|v| VERSIONS.contains(v))
            else {
                return failure(
                    op,
                    "MCP server selected an unsupported protocol version",
                    false,
                );
            };
            if !result["capabilities"].is_object() || !result["serverInfo"].is_object() {
                return failure(op, "Invalid MCP initialize result", false);
            }
            op.version = Some(version.into());
            op.stage = Stage::Notify;
            let payload = op.http_payload(
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                true,
            );
            queue_http(op, payload)
        }
        Stage::Notify => {
            if !value["status"]
                .as_u64()
                .is_some_and(|s| [202, 204].contains(&s))
            {
                let status = value["status"].as_u64().unwrap_or(0);
                return failure(
                    op,
                    &format!("MCP initialized notification failed (HTTP status {status})"),
                    false,
                );
            }
            op.stage = Stage::List;
            issue(op, "tools/list", json!({}))
        }
        Stage::List => {
            let result = match op.rpc_result(value) {
                Ok(v) => v,
                Err((e, u)) => return failure(op, &e, u),
            };
            match op.admit_page(&result) {
                Err(e) => return failure(op, e, false),
                Ok(Some(cursor)) => return issue(op, "tools/list", json!({"cursor":cursor})),
                Ok(None) => {}
            }
            if op.aggregate {
                return next_server(op, None);
            }
            if op.request["action"] != "call" {
                return discovery_complete(op);
            }
            let params = match op.call_params() {
                Ok(params) => params,
                Err(error) => return op.fail(error, false),
            };
            op.stage = Stage::Call;
            issue(op, "tools/call", params)
        }
        Stage::Call => {
            let result = match op.rpc_result(value) {
                Ok(v) => v,
                Err((e, u)) => return failure(op, &e, u),
            };
            if !result["content"].is_array()
                || result["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| !c.is_object() || !c["type"].is_string())
                || result.get("isError").is_some_and(|v| !v.is_boolean())
                || result
                    .get("structuredContent")
                    .is_some_and(|v| !v.is_object())
            {
                return op.fail("Invalid MCP tools/call result", true);
            }
            op.complete(result)
        }
    }
}
struct Component;
impl Guest for Component {
    fn manifest() -> PluginManifest {
        PluginManifest { id: "microcrab.mcp-bridge".into(), name: "MCP bridge".into(), version: env!("CARGO_PKG_VERSION").into(), description: Some("Multi-server MCP tools. List servers and tools; describe(server) lists tools, describe(server, tool) returns schema and call_pin. Call with only pin and arguments. Expired references require describe again; never retry uncertain effects.".into()), targets: vec![ViewTarget::Sidebar, ViewTarget::SettingPage], network_origins: None }
    }
    fn init(_ctx: String) -> String {
        config_request("resource-list", json!({})).to_string()
    }
    fn render_view(target: ViewTarget, _vars: String, ctx: String) -> ViewOutput {
        if !matches!(target, ViewTarget::Sidebar | ViewTarget::SettingPage) {
            return ViewOutput {
                schema_version: 1,
                mode: RenderMode::NativeJson,
                content: "null".into(),
                vars_patch: None,
                rerender: false,
                error: None,
            };
        }
        let zh = decode(&ctx)["locale"]
            .as_str()
            .is_none_or(|l| l.starts_with("zh"));
        let label = |en: &str, cn: &str| if zh { cn.to_owned() } else { en.to_owned() };
        let tree = json!({"type":"column","children":[
            {"type":"text","props":{"text":label("MCP servers", "MCP 服务器")}},
            {"type":"notice","props":{"text":label("Add/enable grants this plugin access to this exact server origin and its tools. Disable/remove revokes it. Credentials stay in owner/server/plugin-scoped browser LocalStorage. Browser CORS and HTTPS mixed-content restrictions apply. POST JSON and bounded SSE responses are supported; no background GET stream.","添加或启用会授权此插件访问这个服务器来源及其工具；禁用或移除会撤销授权。凭据保存在按所有者、应用服务器及插件隔离的浏览器 LocalStorage 中。浏览器 CORS 和 HTTPS 混合内容限制仍然适用。支持 POST JSON 和有界 SSE 响应，不建立后台 GET 流。")}},
            {"type":"text","props":{"text":label("Updating plugin bytes revokes grants; add/update the server to authorize the new artifact. Blank authorization retains credentials only for the same endpoint; select Clear to remove credentials.","更新插件文件会撤销授权；添加或更新服务器以授权新的插件版本。Authorization 留空仅保留同一地址的凭据；选择清除可删除凭据。")}},
            {"type":"form","props":{"action":"configure"},"children":[
                {"type":"input","props":{"label":label("Server ID","服务器 ID"),"bind":"id","value":{"$ref":"id"}}},
                {"type":"input","props":{"label":label("HTTP(S) endpoint","HTTP(S) 地址"),"bind":"endpoint","value":{"$ref":"endpoint"}}},
                {"type":"input","props":{"label":label("Authorization (blank keeps existing credential for the same endpoint)","Authorization（留空保留同一地址的现有凭据）"),"bind":"authorization","input_type":"password","value":{"$ref":"authorization"}}},
                {"type":"select","props":{"label":label("Credential action","凭据操作"),"bind":"clear_authorization","value":{"$ref":"clear_authorization"},"options":[{"label":label("Keep / replace","保留或替换"),"value":"false"},{"label":label("Clear credential","清除凭据"),"value":"true"}]}},
                {"type":"select","props":{"label":label("Grant","授权"),"bind":"enabled","value":{"$ref":"enabled"},"options":[{"label":label("Enabled","启用"),"value":"true"},{"label":label("Disabled","禁用"),"value":"false"}]}},
                {"type":"button","props":{"label":label("Add / update server","添加或更新服务器"),"action":"save-config"}}
            ]},
            {"type":"text","props":{"text":{"$ref":"status"}}},
            {"type":"repeat","props":{"items":{"$ref":"servers"},"as":"server"},"children":[
                {"type":"text","props":{"text":{"$ref":"server.id"}}},
                {"type":"text","props":{"text":{"$ref":"server.origin"}}},
                {"type":"text","props":{"text":{"$ref":"server.enabled"}}},
                {"type":"text","props":{"text":{"$ref":"server.requires_reenable"}}},
                {"type":"button","props":{"label":label("Remove / revoke","移除并撤销授权"),"action":"remove","action_payload":{"$ref":"server"}}}
            ]}
        ]});
        ViewOutput {
            schema_version: 1,
            mode: RenderMode::NativeJson,
            content: tree.to_string(),
            vars_patch: None,
            rerender: false,
            error: None,
        }
    }
    fn on_action(action: String, payload: String, vars: String, _ctx: String) -> String {
        let p = decode(&payload);
        let vars = decode(&vars);
        let mut result = match action.as_str() {
            "configure" | "save-config" => config_request(
                "resource-configure",
                json!({"id":vars["id"].as_str().unwrap_or(""),"endpoint":vars["endpoint"].as_str().unwrap_or(""),"authorization":vars["authorization"].as_str().unwrap_or(""),"enabled":vars["enabled"] != "false","clear_authorization":vars["clear_authorization"] == "true"}),
            ),
            "remove" => config_request("resource-configure", json!({"id":p["id"],"remove":true})),
            _ => empty(),
        };
        // Clear the transient native password input after queuing; credentials are
        // never copied into plugin HTML, model output or persistent guest vars.
        result["vars_patch"] = json!({"authorization":""});
        result.to_string()
    }
    fn on_phase(phase: String, payload: String, _vars: String, _ctx: String) -> String {
        if phase != "event-result" {
            return empty().to_string();
        }
        let event = decode(&payload);
        let Some(id) = event["request_id"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
        else {
            return empty().to_string();
        };
        let config = CONFIG_REQUESTS.with(|p| {
            let mut p = p.borrow_mut();
            if let Some(i) = p.iter().position(|v| *v == id) {
                p.remove(i);
                true
            } else {
                false
            }
        });
        if config {
            return if event["ok"] == true { json!({"schema_version":1,"vars_patch":{"servers":safe_servers(&event["value"]),"status":""}}) } else { json!({"schema_version":1,"vars_patch":{"status":event["error"].as_str().unwrap_or("Configuration failed")}}) }.to_string();
        }
        PENDING
            .with(|p| p.borrow_mut().remove(&id))
            .map(|op| advance(op, &event))
            .unwrap_or_else(empty)
            .to_string()
    }
    fn start_tool(request: String, ctx: String) -> String {
        let op = Operation::new(decode(&request), decode(&ctx));
        if PENDING.with(|p| p.borrow().len()) >= 32 {
            return op
                .fail("MCP pending operation limit exceeded", false)
                .to_string();
        }
        match resources::request("resource-list", "{}") {
            Ok(id) => {
                let result = reply(&op.identity, "pending", Value::Null, None, false);
                PENDING.with(|p| p.borrow_mut().insert(id, op));
                result.to_string()
            }
            Err(_) => op
                .fail("MCP configuration is unavailable", false)
                .to_string(),
        }
    }
    fn cancel_tool(ctx: String) -> String {
        let identity = decode(&ctx)["tool_invocation"].clone();
        let pending: Vec<Operation> = PENDING.with(|p| {
            let mut p = p.borrow_mut();
            let operations = p
                .values()
                .filter(|op| op.identity == identity)
                .cloned()
                .collect();
            p.retain(|_, op| op.identity != identity);
            operations
        });
        // Best-effort cancellation is a separate bounded notification, never a
        // retry of tools/call. The host permits one cleanup request for one second.
        for op in pending.into_iter().take(1) {
            if !matches!(op.stage, Stage::Resources | Stage::Initialize) && !op.rpc_id.is_empty() {
                let payload = op.http_payload(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":op.rpc_id,"reason":"Client cancelled request"}}), true);
                let _ = net::request("http", &payload.to_string());
            }
        }
        empty().to_string()
    }
}
export!(Component);
