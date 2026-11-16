//! Independent MCP service logic. Browser host supplies only generic resource
//! grants, bounded HTTP/SSE responses, cancellation and durable tool completion.
mod arguments;
mod call_pins;
mod discovery;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn pin(value: &Value) -> String {
    let digest = Sha256::digest(value.to_string().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}
fn reply(
    identity: &Value,
    status: &str,
    output: Value,
    error: Option<&str>,
    unknown: bool,
) -> Value {
    let mut c = json!({"identity":identity,"status":status});
    if status == "completed" {
        c["output"] = output;
    }
    if let Some(error) = error {
        c["error"] = error.into();
        c["outcome_unknown"] = unknown.into();
    }
    json!({"schema_version":1,"tool_completion":c})
}
#[cfg(target_arch = "wasm32")]
const VERSIONS: [&str; 3] = ["2025-11-25", "2025-06-18", "2025-03-26"];
#[derive(Clone, Debug)]
enum Stage {
    Resources,
    Initialize,
    #[cfg(target_arch = "wasm32")]
    Notify,
    List,
    Call,
}
#[derive(Clone)]
struct Operation {
    identity: Value,
    request: Value,
    resource: Value,
    stage: Stage,
    rpc_id: String,
    session: Option<String>,
    version: Option<String>,
    tools: Vec<Value>,
    cursors: Vec<String>,
    pages: usize,
    aggregate: bool,
    resources: Vec<Value>,
    servers: Vec<Value>,
    offset: usize,
    seen: usize,
    summaries: usize,
}
impl Operation {
    fn new(request: Value, ctx: Value) -> Self {
        Self {
            identity: ctx["tool_invocation"].clone(),
            request,
            resource: Value::Null,
            stage: Stage::Resources,
            rpc_id: String::new(),
            session: None,
            version: None,
            tools: vec![],
            cursors: vec![],
            pages: 0,
            aggregate: false,
            resources: vec![],
            servers: vec![],
            offset: 0,
            seen: 0,
            summaries: 0,
        }
    }
    fn fail(&self, error: &str, unknown: bool) -> Value {
        reply(&self.identity, "failed", Value::Null, Some(error), unknown)
    }
    fn complete(&self, output: Value) -> Value {
        if output.to_string().len() > 60 * 1024 {
            return self.fail(
                "MCP result exceeds the durable result budget; use a smaller page or remote result",
                matches!(self.stage, Stage::Call),
            );
        }
        reply(&self.identity, "completed", output, None, false)
    }
    #[cfg(target_arch = "wasm32")]
    fn rpc_body(&mut self, sequence: u64, method: &str, params: Value) -> Value {
        self.rpc_id = format!(
            "{}:{sequence}",
            self.identity["invocation_id"].as_str().unwrap_or("invalid")
        );
        json!({"jsonrpc":"2.0","id":self.rpc_id,"method":method,"params":params})
    }
    fn http_payload(&self, body: Value, notification: bool) -> Value {
        let mut headers = json!({"Content-Type":"application/json","Accept":"application/json, text/event-stream"});
        if let Some(session) = &self.session {
            headers["Mcp-Session-Id"] = session.clone().into();
        }
        if let Some(version) = &self.version {
            headers["MCP-Protocol-Version"] = version.clone().into();
        }
        let mut p = json!({"resource":self.resource["id"],"config_pin":self.resource["config_pin"],"method":"POST","headers":headers,"body":body.to_string()});
        if notification {
            p["response_mode"] = "discard".into();
        }
        if !notification {
            p["response_id"] = self.rpc_id.clone().into();
        }
        p
    }
    fn rpc_result(&mut self, response: &Value) -> Result<Value, (String, bool)> {
        let unknown = matches!(self.stage, Stage::Call);
        let status = match response["status"].as_u64() {
            Some(s) => s,
            None => {
                return Err((
                    "Invalid MCP HTTP response: missing status code".into(),
                    unknown,
                ));
            }
        };
        if !(200..300).contains(&status) {
            let detail = match status {
                401 | 403 => format!(
                    "MCP server returned HTTP {status} (Unauthorized/Forbidden); verify server authorization headers or credentials"
                ),
                404 => "MCP server returned HTTP 404 (Not Found); check server endpoint URL".into(),
                429 => {
                    "MCP server returned HTTP 429 (Too Many Requests); upstream rate limit exceeded"
                        .into()
                }
                500..=599 => format!(
                    "MCP server returned HTTP {status} (Server Error); upstream service error"
                ),
                _ => format!(
                    "MCP server returned HTTP {status}; check server status, CORS headers, and network configuration"
                ),
            };
            return Err((detail, unknown));
        }
        if let Some(session) = response["headers"]["mcp-session-id"].as_str() {
            if session.is_empty()
                || session.len() > 1024
                || !session.bytes().all(|b| (0x21..=0x7e).contains(&b))
            {
                return Err(("Invalid MCP session identifier".into(), unknown));
            }
            if self.session.as_deref().is_some_and(|old| old != session) {
                return Err(("MCP session identity changed".into(), unknown));
            }
            self.session = Some(session.into());
        }
        let content_type = response["headers"]["content-type"]
            .as_str()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if !["application/json", "text/event-stream"].contains(&content_type) {
            return Err(("MCP response must be JSON or SSE".into(), unknown));
        }
        let rpc = decode(response["body"].as_str().unwrap_or(""));
        if rpc["jsonrpc"] != "2.0"
            || rpc["id"] != self.rpc_id
            || rpc.get("result").is_some() == rpc.get("error").is_some()
        {
            return Err((
                "MCP response has invalid JSON-RPC identity/envelope".into(),
                unknown,
            ));
        }
        if let Some(error) = rpc.get("error") {
            if !error["code"].is_i64() || !error["message"].is_string() {
                return Err(("Invalid MCP JSON-RPC error".into(), unknown));
            }
            let code = error["code"].as_i64().unwrap_or(0);
            return Err((
                format!("MCP server rejected JSON-RPC request (code {code})"),
                false,
            ));
        }
        Ok(rpc["result"].clone())
    }
    fn admit_page(&mut self, result: &Value) -> Result<Option<String>, &'static str> {
        self.pages += 1;
        if self.pages > 100 {
            return Err("MCP catalog exceeds 100 pages");
        }
        let tools = result["tools"]
            .as_array()
            .ok_or("Invalid MCP tools/list response")?;
        for tool in tools {
            let name = tool["name"].as_str().ok_or("Invalid MCP tool name")?;
            if name.is_empty()
                || name.len() > 256
                || !tool["inputSchema"].is_object()
                || tool["inputSchema"]["type"] != "object"
                || tool.get("description").is_some_and(|v| !v.is_string())
            {
                return Err("Invalid MCP tool definition");
            }
            if self.tools.iter().any(|t| t["name"] == name) {
                return Err("Duplicate MCP tool name across pages");
            }
            if self.tools.len() >= 1000 {
                return Err("MCP catalog exceeds 1000 tools");
            }
            // Store only canonical fields used by discovery and exact schema pins.
            self.tools.push(json!({"name":name,"description":tool["description"],"inputSchema":tool["inputSchema"]}));
        }
        if self
            .tools
            .iter()
            .map(|t| t.to_string().len())
            .sum::<usize>()
            > 2 * 1024 * 1024
        {
            return Err("MCP catalog exceeds 2 MiB");
        }
        match result.get("nextCursor") {
            None => Ok(None),
            Some(Value::String(cursor))
                if !cursor.is_empty()
                    && cursor.len() <= 4096
                    && !self.cursors.contains(cursor)
                    && self.pages < 100 =>
            {
                self.cursors.push(cursor.clone());
                Ok(Some(cursor.clone()))
            }
            _ => Err("Invalid, repeated, or excessive MCP pagination cursor"),
        }
    }
    fn discovery(&self, pins: &mut call_pins::CallPins, cursors: &mut discovery::Cursors) -> Value {
        if self.aggregate {
            return match cursors.aggregate(
                &self.identity,
                &self.request,
                &self.resources,
                &self.servers,
            ) {
                Ok(output) => self.complete(output),
                Err(error) => self.fail(error, false),
            };
        }
        if self.request["action"] == "list" || self.request.get("tool").is_none() {
            return match cursors.server(&self.identity, &self.request, &self.resource, &self.tools)
            {
                Ok(output) => self.complete(output),
                Err(error) => self.fail(error, false),
            };
        }
        let Some(tool) = self
            .tools
            .iter()
            .find(|t| t["name"] == self.request["tool"])
        else {
            return self.fail("MCP tool does not exist on the exact server", false);
        };
        let schema_pin = pin(&tool["inputSchema"]);
        let target = call_pins::CallTarget {
            server: self.resource["id"].as_str().unwrap_or("").into(),
            tool: tool["name"].as_str().unwrap_or("").into(),
            config_pin: self.resource["config_pin"].as_str().unwrap_or("").into(),
            schema_pin: schema_pin.clone(),
        };
        let call_pin = match pins.mint(&self.identity, target) {
            Ok(token) => token,
            Err(error) => return self.fail(error, false),
        };
        self.complete(json!({"server":self.resource["id"],"tool":tool["name"],"parameters":tool["inputSchema"],"call_pin":call_pin,"schema_pin":schema_pin[..16],"config_pin":discovery::short(&self.resource["config_pin"]),"usage_hint":"Call with pin=call_pin and arguments; omit server, tool, config_pin and schema_pin."}))
    }
    fn call_params(&self) -> Result<Value, &'static str> {
        let tool = self
            .tools
            .iter()
            .find(|t| t["name"] == self.request["tool"])
            .ok_or("MCP tool is absent on the exact server")?;
        if self.request["schema_pin"] != pin(&tool["inputSchema"])
            || self.request["config_pin"] != self.resource["config_pin"]
        {
            return Err("MCP schema/configuration changed; no tool was called");
        }
        let args = self.request.get("arguments").cloned().unwrap_or(json!({}));
        if !args.is_object() {
            return Err("MCP tool arguments must be an object");
        }
        arguments::validate(&tool["inputSchema"], &args)?;
        Ok(json!({"name":self.request["tool"],"arguments":args}))
    }
    fn begin_catalog(&mut self, resource: Value) {
        self.resource = resource;
        self.stage = Stage::Initialize;
        self.session = None;
        self.version = None;
        self.rpc_id.clear();
        self.tools.clear();
        self.cursors.clear();
        self.pages = 0;
    }
    fn retain_server(&mut self, error: Option<&str>) {
        let count = if error.is_some() { 0 } else { self.tools.len() };
        let start = self.offset.saturating_sub(self.seen);
        let summaries: Vec<_> = self
            .tools
            .iter()
            .skip(start)
            .take(discovery::limit(&self.request).saturating_sub(self.summaries))
            .filter(|_| error.is_none())
            .map(discovery::summary)
            .collect();
        self.summaries += summaries.len();
        self.seen += count.max(1);
        let mut server = json!({"id":self.resource["id"],"config_pin":self.resource["config_pin"],"catalog_pin":pin(&Value::Array(self.tools.clone())),"tool_count":count,"tools":summaries});
        if let Some(error) = error {
            server["error"] = error.into();
        }
        self.servers.push(server);
        self.tools.clear();
    }
}
#[cfg(test)]
mod discovery_tests;
#[cfg(target_arch = "wasm32")]
mod runtime;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rpc_identity_and_uncertain_effect_are_preserved() {
        let mut op = Operation::new(json!({}), json!({"tool_invocation":{"invocation_id":"i"}}));
        op.stage = Stage::Call;
        op.rpc_id = "i:1".into();
        assert_eq!(
            op.rpc_result(
                &json!({"status":200,"headers":{"content-type":"application/json"},"body":"{\"jsonrpc\":\"2.0\",\"id\":\"wrong\",\"result\":{}}"})
            )
            .unwrap_err()
            .1,
            true
        );
        assert!(!op.rpc_result(&json!({"status":200,"headers":{"content-type":"application/json"},"body":"{\"jsonrpc\":\"2.0\",\"id\":\"i:1\",\"error\":{\"code\":-1,\"message\":\"private\"}}"})).unwrap_err().1);
    }
    #[test]
    fn http_failures_preserve_effect_uncertainty_without_suggesting_replay() {
        let mut op = Operation::new(json!({}), json!({}));
        for stage in [Stage::Initialize, Stage::List, Stage::Call] {
            let expected_unknown = matches!(stage, Stage::Call);
            op.stage = stage;
            for status in [401, 403, 404, 429, 500, 502, 503, 504] {
                let (error, unknown) = op.rpc_result(&json!({"status":status})).unwrap_err();
                assert_eq!(
                    unknown, expected_unknown,
                    "stage {:?}, status {status}",
                    op.stage
                );
                assert!(error.contains(&status.to_string()), "{error}");
                assert!(!error.contains("retry"), "{error}");
            }
        }
    }
    #[test]
    fn rpc_rejection_retains_code_without_remote_private_bodies() {
        let mut op = Operation::new(json!({}), json!({}));
        op.stage = Stage::Call;
        op.rpc_id = "call:1".into();
        let (error, unknown) = op
            .rpc_result(&json!({
                "status":200,"headers":{"content-type":"application/json"},
                "body":json!({"jsonrpc":"2.0","id":"call:1","error":{
                    "code":-32602,"message":"private credential and request body",
                    "data":{"secret":"private"}
                }}).to_string()
            }))
            .unwrap_err();
        assert!(error.contains("-32602"), "{error}");
        assert!(!error.contains("private"), "{error}");
        assert!(!unknown, "an exact RPC rejection has a known outcome");
    }
    #[test]
    fn pagination_rejects_duplicate_names_and_cycles() {
        let mut op = Operation::new(json!({}), json!({}));
        let page =
            json!({"tools":[{"name":"one","inputSchema":{"type":"object"}}],"nextCursor":"c"});
        assert_eq!(op.admit_page(&page).unwrap(), Some("c".into()));
        assert!(op.admit_page(&page).is_err());
        let mut op = Operation::new(json!({}), json!({}));
        assert!(op.admit_page(&json!({"tools":[],"nextCursor":"c"})).is_ok());
        assert!(
            op.admit_page(&json!({"tools":[],"nextCursor":"c"}))
                .is_err()
        );
    }
    #[test]
    fn schema_pin_is_exact_and_pagination_is_bounded() {
        assert_ne!(
            pin(&json!({"type":"object"})),
            pin(&json!({"type":"object","required":["a"]}))
        );
        let mut op = Operation::new(json!({"action":"list","limit":1}), json!({}));
        op.resource = json!({"id":"s","config_pin":"c"});
        op.admit_page(&json!({"tools":[{"name":"a","inputSchema":{"type":"object"}},{"name":"b","inputSchema":{"type":"object"}}]})).unwrap();
        let out = op.discovery(
            &mut call_pins::CallPins::default(),
            &mut discovery::Cursors::default(),
        );
        assert_eq!(
            out["tool_completion"]["output"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(out["tool_completion"]["output"]["next_cursor"].is_string());
    }
}
