//! Bounded model discovery pages. Opaque cursors retain exact identities only here.
use super::{Value, json, pin};
use std::collections::{BTreeMap, VecDeque};

const CAPACITY: usize = 256;
const STALE: &str =
    "MCP discovery cursor expired or catalog/configuration changed; restart discovery";
pub(crate) fn short(value: &Value) -> String {
    pin(value)[..16].to_owned()
}
pub(crate) fn limit(request: &Value) -> usize {
    request["limit"].as_u64().unwrap_or(20).clamp(1, 32) as usize
}
pub(crate) fn summary(tool: &Value) -> Value {
    json!({"name":tool["name"],"description":tool["description"].as_str().unwrap_or("").chars().take(512).collect::<String>()})
}
pub(crate) fn inventory(resources: &[Value]) -> String {
    pin(&Value::Array(
        resources
            .iter()
            .map(|r| json!([r["id"], r["config_pin"]]))
            .collect(),
    ))
}
#[derive(Clone, PartialEq)]
struct Position {
    scope: Value,
    inventory: String,
    catalog: String,
    offset: usize,
}
#[derive(Default)]
pub(crate) struct Cursors {
    entries: BTreeMap<String, Option<Position>>,
    order: VecDeque<String>,
}
impl Cursors {
    pub(crate) fn check(
        &self,
        identity: &Value,
        token: &str,
        inventory: &str,
    ) -> Result<(), &'static str> {
        let entry = self
            .entries
            .get(token)
            .and_then(Option::as_ref)
            .ok_or(STALE)?;
        if entry.scope != super::call_pins::scope(identity) || entry.inventory != inventory {
            return Err(STALE);
        }
        Ok(())
    }
    pub(crate) fn start(
        &self,
        identity: &Value,
        request: &Value,
        inventory: &str,
    ) -> Result<usize, &'static str> {
        let Some(token) = request.get("cursor") else {
            return Ok(0);
        };
        let token = token.as_str().ok_or(STALE)?;
        self.check(identity, token, inventory)?;
        Ok(self
            .entries
            .get(token)
            .and_then(Option::as_ref)
            .ok_or(STALE)?
            .offset)
    }
    fn offset(
        &self,
        identity: &Value,
        request: &Value,
        inventory: &str,
        catalog: &str,
    ) -> Result<usize, &'static str> {
        let Some(token) = request.get("cursor") else {
            return Ok(0);
        };
        let token = token.as_str().ok_or(STALE)?;
        self.check(identity, token, inventory)?;
        let entry = self
            .entries
            .get(token)
            .and_then(Option::as_ref)
            .ok_or(STALE)?;
        if entry.catalog != catalog {
            return Err(STALE);
        }
        Ok(entry.offset)
    }
    fn mint(
        &mut self,
        identity: &Value,
        inventory: &str,
        catalog: &str,
        offset: usize,
    ) -> Result<Value, &'static str> {
        let position = Position {
            scope: super::call_pins::scope(identity),
            inventory: inventory.into(),
            catalog: catalog.into(),
            offset,
        };
        let token = short(&json!([
            "microcrab.mcp.discovery.v1",
            position.scope,
            inventory,
            catalog,
            offset
        ]));
        self.insert(token.clone(), position)?;
        Ok(token.into())
    }
    fn insert(&mut self, token: String, position: Position) -> Result<(), &'static str> {
        if let Some(old) = self.entries.get_mut(&token) {
            if old.as_ref() == Some(&position) {
                return Ok(());
            }
            *old = None;
            return Err("MCP discovery cursor is ambiguous; restart discovery");
        }
        if self.order.len() >= CAPACITY {
            if let Some(old) = self.order.pop_front() {
                self.entries.remove(&old);
            }
        }
        self.order.push_back(token.clone());
        self.entries.insert(token, Some(position));
        Ok(())
    }
    pub(crate) fn server(
        &mut self,
        identity: &Value,
        request: &Value,
        resource: &Value,
        tools: &[Value],
    ) -> Result<Value, &'static str> {
        let inventory = inventory(std::slice::from_ref(resource));
        let catalog = pin(&json!(["server", tools]));
        let offset = self.offset(identity, request, &inventory, &catalog)?;
        if offset > tools.len() {
            return Err(STALE);
        }
        let page: Vec<_> = tools
            .iter()
            .skip(offset)
            .take(limit(request))
            .map(summary)
            .collect();
        let next = offset + page.len();
        let cursor = if next < tools.len() {
            self.mint(identity, &inventory, &catalog, next)?
        } else {
            Value::Null
        };
        Ok(
            json!({"server":resource["id"],"config_pin":short(&resource["config_pin"]),"catalog_pin":catalog[..16],"tools":page,"next_cursor":cursor,"usage_hint":"Use describe with server and tool to inspect parameters and obtain call_pin; then call with pin and arguments."}),
        )
    }
    pub(crate) fn aggregate(
        &mut self,
        identity: &Value,
        request: &Value,
        resources: &[Value],
        servers: &[Value],
    ) -> Result<Value, &'static str> {
        let inventory = inventory(resources);
        let catalog = pin(&json!([
            "aggregate",
            servers
                .iter()
                .map(|s| json!([
                    s["id"],
                    s["config_pin"],
                    s["catalog_pin"],
                    s["tool_count"],
                    s["error"]
                ]))
                .collect::<Vec<_>>()
        ]));
        let offset = self.offset(identity, request, &inventory, &catalog)?;
        // Empty/error servers occupy a position, but never consume the tool budget.
        // Resources are host-bounded to 32, so even an all-error page is bounded.
        let total: usize = servers
            .iter()
            .map(|s| s["tool_count"].as_u64().unwrap_or(0).max(1) as usize)
            .sum();
        if offset > total {
            return Err(STALE);
        }
        let mut position = 0;
        let mut count = 0;
        let mut next = offset;
        let mut page = Vec::new();
        for server in servers {
            let tools = server["tools"]
                .as_array()
                .ok_or("Invalid retained MCP discovery")?;
            let tool_count = server["tool_count"].as_u64().unwrap_or(0) as usize;
            let width = tool_count.max(1);
            if position + width <= offset {
                position += width;
                continue;
            }
            if count >= limit(request) {
                break;
            }
            let start = offset.saturating_sub(position);
            let take = tools.len();
            let mut entry =
                json!({"id":server["id"],"config_pin":short(&server["config_pin"]),"tools":tools});
            if let Some(error) = server.get("error") {
                entry["error"] = error.clone();
            }
            page.push(entry);
            count += take;
            next = position + if tool_count == 0 { 1 } else { start + take };
            position += width;
        }
        let cursor = if next < total {
            self.mint(identity, &inventory, &catalog, next)?
        } else {
            Value::Null
        };
        Ok(json!({"servers":page,"next_cursor":cursor}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collision_tombstones_and_fifo_eviction_fail_closed() {
        let identity = json!({"session_id":"s"});
        let mut cursors = Cursors::default();
        let token = cursors
            .mint(&identity, "full-inventory", "full-catalog", 1)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let mut different = cursors.entries[&token].clone().unwrap();
        different.catalog.push('x');
        assert!(cursors.insert(token.clone(), different).is_err());
        assert!(cursors.check(&identity, &token, "full-inventory").is_err());
        assert!(
            cursors
                .mint(&identity, "full-inventory", "full-catalog", 1)
                .is_err()
        );
        for offset in 2..=CAPACITY + 1 {
            cursors
                .mint(&identity, "full-inventory", "full-catalog", offset)
                .unwrap();
        }
        assert_eq!(cursors.entries.len(), CAPACITY);
        assert_eq!(cursors.order.len(), CAPACITY);
        assert!(!cursors.entries.contains_key(&token));
        assert!(cursors.check(&identity, &token, "full-inventory").is_err());
    }
}
