//! Whole-object parsing and diff validation precede the single atomic host write.
use super::*;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

// serde_json::Value normally overwrites duplicate keys. Reject them at every
// object depth so the reviewed text has exactly one interpretation.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut values = Vec::new();
                while let Some(Unique(v)) = a.next_element()? {
                    values.push(v);
                }
                Ok(Unique(values.into()))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut values = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if values.contains_key(&k) {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate object key {k:?}"
                        )));
                    }
                    let Unique(v) = a.next_value()?;
                    values.insert(k, v);
                }
                Ok(Unique(Value::Object(values)))
            }
        }
        d.deserialize_any(JsonVisitor)
    }
}

pub(super) fn context(vars: &Value, ctx: &Value) -> Value {
    json!({"values":vars["values"],"metadata":vars["metadata"],"descriptors":vars["descriptors"],"witness":vars["witness"],
        "fence":fence(ctx),"surface_id":surface(ctx),"surface_generation":ctx["surface_generation"].as_u64().unwrap_or(0),"target":ctx["surface"]["target"]})
}
fn diagnostic(path: Option<String>, message: String) -> Value {
    let mut d = json!({"message":message,"severity":"error"});
    if let Some(path) = path {
        d["path"] = path.into();
    }
    d
}
fn pointer(key: &str) -> String {
    format!("/{}", key.replace('~', "~0").replace('/', "~1"))
}
pub(super) fn diff(base: &Value, text: &str) -> Result<Value, String> {
    checked_diff(base, text).map_err(|errors| {
        errors
            .iter()
            .filter_map(|d| d["message"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    })
}
fn parse(text: &str) -> Result<Map<String, Value>, String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("JSON draft exceeds 4 MiB / JSON 草稿超过 4 MiB".into());
    }
    let Unique(next) = serde_json::from_str::<Unique>(text).map_err(|e| format!("JSON: {e}"))?;
    match next {
        Value::Object(next) => Ok(next),
        _ => Err("JSON root must be an object / JSON 根必须是对象".into()),
    }
}
fn checked_diff(base: &Value, text: &str) -> Result<Value, Vec<Value>> {
    let next = parse(text).map_err(|error| vec![diagnostic(None, error)])?;
    let before = base["values"].as_object().ok_or_else(|| {
        vec![diagnostic(
            None,
            "Missing original values / 缺少原始值".into(),
        )]
    })?;
    let mut errors = Vec::new();
    let mut set = Map::new();
    let mut scoped = Vec::new();
    let mut remove = Vec::new();
    for (key, value) in &next {
        if before.get(key) == Some(value) {
            continue;
        }
        if before.contains_key(key) {
            if !rights(base, key).0 {
                errors.push(diagnostic(
                    Some(pointer(key)),
                    reason(
                        base,
                        key,
                        "Client cannot edit this field / 客户端不能编辑此字段",
                    ),
                ));
                continue;
            }
            set.insert(key.clone(), value.clone());
        } else {
            scoped.push(json!({"name":key,"value":value,"visibility":"visible","persistence":"persisted","editors":["agent","client","runtime"]}));
        }
    }
    for key in before.keys().filter(|key| !next.contains_key(*key)) {
        if !rights(base, key).2 {
            errors.push(diagnostic(
                Some(pointer(key)),
                reason(
                    base,
                    key,
                    "Only the Client owner may delete this field / 仅客户端所有者可删除此字段",
                ),
            ));
            continue;
        }
        remove.push(key.clone());
    }
    let mut change = Map::new();
    if !set.is_empty() {
        change.insert("set".into(), set.into());
    }
    if !scoped.is_empty() {
        change.insert("scoped_set".into(), scoped.into());
    }
    if !remove.is_empty() {
        change.insert("remove".into(), remove.into());
    }
    if errors.is_empty() {
        Ok(Value::Object(change))
    } else {
        Err(errors)
    }
}
fn reason(base: &Value, key: &str, fallback: &str) -> String {
    format!(
        "{key}: {}",
        base["descriptors"][key]["reason"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
    )
}
fn validate_scope(base: &Value, vars: &Value, ctx: &Value) -> Result<(), String> {
    let sid = surface(ctx);
    if ctx["surface"]["target"] == "block-slot" || base["target"] == "block-slot" {
        return Err("Block slots are read-only / 区块视图只读".into());
    }
    if base["fence"] != fence(ctx)
        || base["surface_id"] != sid
        || base["surface_generation"].as_u64()
            != Some(ctx["surface_generation"].as_u64().unwrap_or(0))
        || base["target"] != ctx["surface"]["target"]
    {
        return Err(
            "Editor scope changed; reopen the editor / 编辑范围已更改，请重新打开编辑器".into(),
        );
    }
    if vars["has_snapshot"] != true
        || !valid_witness(&base["witness"])
        || !base["metadata"].is_object()
        || !base["descriptors"].is_object()
    {
        return Err("Read an atomic inspection first / 请先读取完整状态快照".into());
    }
    Ok(())
}
pub(super) fn action(
    action: &str,
    payload: &Value,
    vars: &mut Value,
    ctx: &Value,
    request: &impl Fn(&str, &Value) -> Result<u32, String>,
) {
    let Some(sid) = ctx["surface"]["surface_id"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    if action == "validate-json" {
        // Pure validation of the editor's full captured baseline. Never touch the
        // retained operation state, even if its write receipt is still unknown.
        let errors = match validate_scope(&payload["context"], vars, ctx) {
            Err(error) => vec![diagnostic(None, error)],
            Ok(()) => match payload["value"].as_str() {
                Some(text) => checked_diff(&payload["context"], text)
                    .err()
                    .unwrap_or_default(),
                None => vec![diagnostic(
                    None,
                    "JSON text is required / 缺少 JSON 文本".into(),
                )],
            },
        };
        vars["validations"][sid] = json!({"validation_id":payload["validation_id"],"status":"validated","diagnostics":errors});
        return;
    }
    let mut e = vars["surfaces"][sid].clone();
    if !e.is_object() {
        e = json!({"status":"idle","detail":"","operation_id":"","pending":null,"observe_request":null});
    }
    if action == "observe-json" {
        if matches!(e["status"].as_str(), Some("unknown" | "queued"))
            && e["operation_id"].as_str().is_some_and(|s| !s.is_empty())
            && e["observe_request"].is_null()
        {
            match request(
                "state-operation",
                &json!({"operation_id":e["operation_id"]}),
            ) {
                Ok(id) => {
                    e["observe_request"] = id.into();
                    e["observe_generation"] =
                        ctx["surface_generation"].as_u64().unwrap_or(0).into();
                }
                Err(error) => e["detail"] = error.into(),
            }
        }
    } else if action == "save-json" {
        // Never replace an unresolved operation, including its correlation token.
        // The toolbar disables save while locked; a stale action has no effects.
        if e["pending"].is_number()
            || matches!(e["status"].as_str(), Some("saving" | "unknown" | "queued"))
        {
            return;
        }
        e = json!({"status":"error","detail":"","edit_id":payload["edit_id"],"operation_id":ctx["invocation_id"],"pending":null,"observe_request":null,"context":payload["context"]});
        let validate = || -> Result<Value, String> {
            let base = &payload["context"];
            validate_scope(base, vars, ctx)?;
            if !payload["edit_id"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err("Missing editor correlation identity / 缺少编辑关联标识".into());
            }
            if !ctx["invocation_id"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err("Host invocation identity is unavailable / 缺少主机调用标识".into());
            }
            diff(
                base,
                payload["value"]
                    .as_str()
                    .ok_or("JSON text is required / 缺少 JSON 文本")?,
            )
        };
        match validate() {
            Err(error) => e["detail"] = error.into(),
            Ok(change) if change.as_object().is_some_and(Map::is_empty) => {
                e["status"] = "saved".into();
                e["detail"] = "No changes / 没有更改".into();
            }
            Ok(change) => match request(
                "state-change",
                &json!({"operation_id":e["operation_id"],"expected":payload["context"]["witness"],"change":change}),
            ) {
                Ok(id) => {
                    e["pending"] = id.into();
                    e["pending_generation"] =
                        ctx["surface_generation"].as_u64().unwrap_or(0).into();
                    e["status"] = "saving".into();
                }
                Err(error) => {
                    e["status"] = "unknown".into();
                    e["detail"] = error.into();
                }
            },
        }
    } else {
        return;
    }
    vars["surfaces"][sid] = e;
}
