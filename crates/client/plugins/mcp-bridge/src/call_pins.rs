//! Short model-facing references retain full internal target identity. These
//! references are scoped observations, never network grants or execution authority.
use super::{Value, json, pin};
use std::collections::{BTreeMap, VecDeque};

const CAPACITY: usize = 256;
const EXPIRED: &str = "MCP call token expired or configuration changed; describe the tool again";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CallTarget {
    pub(crate) server: String,
    pub(crate) tool: String,
    pub(crate) config_pin: String,
    pub(crate) schema_pin: String,
}

#[derive(Clone)]
struct Entry {
    scope: Value,
    target: Option<CallTarget>,
}

#[derive(Default)]
pub(crate) struct CallPins {
    entries: BTreeMap<String, Entry>,
    order: VecDeque<String>,
}

pub(crate) fn scope(identity: &Value) -> Value {
    json!({
        "session":identity["session_id"],
        "parent":identity["parent_session_id"],
        "artifact":identity["artifact"],
        "generation":identity["generation"],
        "history_generation":identity["history_generation"],
        "epoch":identity["epoch"],
        "catalog":identity["catalog_digest"]
    })
}

fn matches_config(value: &Value, full: &str) -> bool {
    value.as_str() == Some(full) || value == &super::discovery::short(&Value::String(full.into()))
}
fn matches_schema(value: &Value, full: &str) -> bool {
    value.as_str() == Some(full) || value.as_str() == full.get(..16)
}

impl CallPins {
    pub(crate) fn expand_request(
        &self,
        identity: &Value,
        request: &mut Value,
    ) -> Result<(), &'static str> {
        let target = if let Some(token) = request.get("pin") {
            if ["server", "tool", "config_pin", "schema_pin"]
                .iter()
                .any(|field| request.get(*field).is_some())
            {
                return Err(
                    "MCP call token conflicts with the supplied target; use only pin and arguments",
                );
            }
            self.resolve(
                identity,
                token.as_str().ok_or("MCP call token must be a string")?,
            )?
        } else {
            // Full legacy identities need no observation cache. Short identities
            // require a unique exact retained target in this frozen scope.
            let short_config = request["config_pin"]
                .as_str()
                .is_some_and(|s| s.len() == 16);
            let short_schema = request["schema_pin"]
                .as_str()
                .is_some_and(|s| s.len() == 16);
            if !short_config && !short_schema {
                return Ok(());
            }
            let scope = scope(identity);
            let mut matches = self
                .entries
                .values()
                .filter(|e| e.scope == scope)
                .filter_map(|e| e.target.as_ref())
                .filter(|t| {
                    request["server"] == t.server
                        && request["tool"] == t.tool
                        && matches_config(&request["config_pin"], &t.config_pin)
                        && matches_schema(&request["schema_pin"], &t.schema_pin)
                });
            let Some(target) = matches.next().cloned() else {
                // A host revision may itself have length 16. With a full schema
                // digest leave it intact for the live exact resource comparison.
                if !short_schema {
                    return Ok(());
                }
                return Err(EXPIRED);
            };
            if matches.any(|other| other != &target) {
                return Err("MCP legacy short pins are ambiguous; describe the tool again");
            }
            target
        };
        for (field, expected) in [
            ("server", &target.server),
            ("tool", &target.tool),
            ("config_pin", &target.config_pin),
            ("schema_pin", &target.schema_pin),
        ] {
            request[field] = expected.clone().into();
        }
        Ok(())
    }
    pub(crate) fn mint(
        &mut self,
        identity: &Value,
        target: CallTarget,
    ) -> Result<String, &'static str> {
        let scope = scope(identity);
        let digest = pin(&json!([
            "microcrab.mcp.call.v1",
            scope,
            target.server,
            target.tool,
            target.config_pin,
            target.schema_pin
        ]));
        let token = digest[..16].to_owned();
        self.insert(token.clone(), scope, target)?;
        Ok(token)
    }

    fn insert(
        &mut self,
        token: String,
        scope: Value,
        target: CallTarget,
    ) -> Result<(), &'static str> {
        if let Some(entry) = self.entries.get_mut(&token) {
            if entry.scope == scope && entry.target.as_ref() == Some(&target) {
                return Ok(());
            }
            // A short collision must invalidate the reference, never select one
            // candidate by iteration order. Keep the ambiguous slot until eviction.
            entry.target = None;
            return Err("MCP call token is ambiguous; no tool was called");
        }
        if self.order.len() >= CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(token.clone());
        self.entries.insert(
            token,
            Entry {
                scope,
                target: Some(target),
            },
        );
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        identity: &Value,
        token: &str,
    ) -> Result<CallTarget, &'static str> {
        if token.len() != 16
            || !token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("MCP call token must be 16 lowercase hexadecimal characters");
        }
        let entry = self.entries.get(token).ok_or(EXPIRED)?;
        if entry.scope != scope(identity) {
            return Err(EXPIRED);
        }
        entry
            .target
            .clone()
            .ok_or("MCP call token is ambiguous; no tool was called")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> CallTarget {
        CallTarget {
            server: "server".into(),
            tool: "tool".into(),
            config_pin: "full-config-revision".into(),
            schema_pin: pin(&json!({"type":"object"})),
        }
    }
    #[test]
    fn short_reference_is_deterministic_and_retains_full_identity() {
        let mut pins = CallPins::default();
        let identity = json!({"session_id":"one","generation":1});
        let token = pins.mint(&identity, target()).unwrap();
        assert_eq!(token.len(), 16);
        assert_eq!(pins.mint(&identity, target()).unwrap(), token);
        assert_eq!(pins.resolve(&identity, &token).unwrap(), target());
        let mut changed = target();
        changed.config_pin.push('x');
        assert_ne!(pins.mint(&identity, changed).unwrap(), token);
        let mut changed = target();
        changed.schema_pin = pin(&json!({"type":"object","required":["x"]}));
        assert_ne!(pins.mint(&identity, changed).unwrap(), token);
        for field in [
            "session_id",
            "parent_session_id",
            "artifact",
            "generation",
            "history_generation",
            "epoch",
            "catalog_digest",
        ] {
            let mut other = identity.clone();
            other[field] = json!("changed");
            assert!(pins.resolve(&other, &token).is_err(), "{field}");
        }
    }
    #[test]
    fn pinned_calls_reject_redundant_fields_before_expansion() {
        let identity = json!({"session_id":"one"});
        let mut pins = CallPins::default();
        let target = target();
        let token = pins.mint(&identity, target.clone()).unwrap();
        for (field, value) in [
            ("server", &target.server),
            ("tool", &target.tool),
            ("config_pin", &target.config_pin),
            ("schema_pin", &target.schema_pin),
        ] {
            let mut request = json!({"action":"call","pin":token,field:value});
            let original = request.clone();
            assert!(
                pins.expand_request(&identity, &mut request)
                    .unwrap_err()
                    .contains("conflicts"),
                "{field}"
            );
            assert_eq!(request, original, "rejection must not rewrite arguments");
        }
    }
    #[test]
    fn collision_fails_closed_and_eviction_requires_rediscovery() {
        let mut pins = CallPins::default();
        let identity = json!({"session_id":"one"});
        let token = pins.mint(&identity, target()).unwrap();
        let mut other = target();
        other.tool = "other".into();
        assert!(pins.insert(token.clone(), scope(&identity), other).is_err());
        assert!(
            pins.resolve(&identity, &token)
                .unwrap_err()
                .contains("ambiguous")
        );
        for n in 0..CAPACITY {
            let mut next = target();
            next.tool = n.to_string();
            pins.mint(&identity, next).unwrap();
        }
        assert_eq!(pins.entries.len(), CAPACITY);
        assert!(
            pins.resolve(&identity, &token)
                .unwrap_err()
                .contains("expired")
        );
        assert!(pins.resolve(&identity, "bad").is_err());
    }
}
