//! Bounded, fail-closed JSON Schema subset for MCP arguments. No remote refs,
//! regex execution, implicit defaults/coercions or unbounded combinator expansion.
use serde_json::Value;
const LIMIT: usize = 8192;
fn budget(left: &mut usize, depth: usize) -> Result<(), &'static str> {
    if depth > 32 || *left == 0 {
        return Err("MCP argument schema exceeds validation complexity budget");
    }
    *left -= 1;
    Ok(())
}
fn supported(schema: &Value, left: &mut usize, depth: usize) -> Result<(), &'static str> {
    budget(left, depth)?;
    if schema.is_boolean() {
        return Ok(());
    }
    let object = schema.as_object().ok_or("Invalid MCP JSON Schema")?;
    for key in object.keys() {
        if ![
            "$schema",
            "$id",
            "$defs",
            "definitions",
            "$ref",
            "title",
            "description",
            "default",
            "examples",
            "deprecated",
            "readOnly",
            "writeOnly",
            "type",
            "properties",
            "required",
            "additionalProperties",
            "items",
            "minItems",
            "maxItems",
            "uniqueItems",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
            "minProperties",
            "maxProperties",
            "enum",
            "const",
            "allOf",
            "anyOf",
            "oneOf",
            "not",
        ]
        .contains(&key.as_str())
        {
            return Err("MCP argument schema uses an unsupported validation keyword");
        }
    }
    if let Some(t) = object.get("type") {
        let types: Vec<&Value> = if let Some(a) = t.as_array() {
            a.iter().collect()
        } else {
            vec![t]
        };
        if types.is_empty()
            || types.iter().any(|t| {
                !t.as_str().is_some_and(|s| {
                    [
                        "null", "boolean", "number", "integer", "string", "array", "object",
                    ]
                    .contains(&s)
                })
            })
        {
            return Err("Invalid MCP schema type");
        }
    }
    for key in ["properties", "$defs", "definitions"] {
        if let Some(map) = object.get(key) {
            for s in map
                .as_object()
                .ok_or("Invalid MCP schema property map")?
                .values()
            {
                supported(s, left, depth + 1)?;
            }
        }
    }
    for key in ["additionalProperties", "items", "not"] {
        if let Some(s) = object.get(key) {
            supported(s, left, depth + 1)?;
        }
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(a) = object.get(key) {
            let a = a
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or("Invalid MCP schema alternatives")?;
            for s in a {
                supported(s, left, depth + 1)?;
            }
        }
    }
    if let Some(required) = object.get("required") {
        if !required
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err("Invalid MCP required property list");
        }
    }
    for key in [
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minProperties",
        "maxProperties",
    ] {
        if object.get(key).is_some_and(|v| v.as_u64().is_none()) {
            return Err("Invalid MCP schema size bound");
        }
    }
    for key in [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ] {
        if object.get(key).is_some_and(|v| v.as_f64().is_none()) {
            return Err("Invalid MCP schema numeric bound");
        }
    }
    if object.get("uniqueItems").is_some_and(|v| !v.is_boolean())
        || object
            .get("enum")
            .is_some_and(|v| !v.as_array().is_some_and(|a| !a.is_empty()))
    {
        return Err("Invalid MCP schema enum/uniqueness");
    }
    if object
        .get("$ref")
        .is_some_and(|v| !v.as_str().is_some_and(|s| s == "#" || s.starts_with("#/")))
    {
        return Err("MCP schemas support local JSON Pointer references only");
    }
    Ok(())
}
fn matches(
    schema: &Value,
    root: &Value,
    value: &Value,
    left: &mut usize,
    depth: usize,
) -> Result<bool, &'static str> {
    budget(left, depth)?;
    if let Some(b) = schema.as_bool() {
        return Ok(b);
    }
    if let Some(reference) = schema["$ref"].as_str() {
        let target = if reference == "#" {
            root
        } else {
            root.pointer(&reference[1..])
                .ok_or("MCP schema reference is missing")?
        };
        if !matches(target, root, value, left, depth + 1)? {
            return Ok(false);
        }
    }
    if let Some(kind) = schema.get("type") {
        let check = |t: &Value| match t.as_str() {
            Some("null") => value.is_null(),
            Some("boolean") => value.is_boolean(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("string") => value.is_string(),
            Some("number") => value.is_number(),
            Some("integer") => value.as_f64().is_some_and(|n| n.fract() == 0.0),
            _ => false,
        };
        if !kind
            .as_array()
            .map(|a| a.iter().any(check))
            .unwrap_or_else(|| check(kind))
        {
            return Ok(false);
        }
    }
    if schema.get("const").is_some_and(|c| c != value)
        || schema["enum"]
            .as_array()
            .is_some_and(|a| !a.contains(value))
    {
        return Ok(false);
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(a) = schema[key].as_array() {
            let mut count = 0;
            for s in a {
                if matches(s, root, value, left, depth + 1)? {
                    count += 1;
                }
            }
            if (key == "allOf" && count != a.len())
                || (key == "anyOf" && count == 0)
                || (key == "oneOf" && count != 1)
            {
                return Ok(false);
            }
        }
    }
    if let Some(s) = schema.get("not") {
        if matches(s, root, value, left, depth + 1)? {
            return Ok(false);
        }
    }
    let size = |n: usize, min: &str, max: &str| {
        schema[min].as_u64().is_none_or(|m| n as u64 >= m)
            && schema[max].as_u64().is_none_or(|m| n as u64 <= m)
    };
    if let Some(v) = value.as_str() {
        if !size(v.chars().count(), "minLength", "maxLength") {
            return Ok(false);
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["minimum"].as_f64().is_some_and(|m| n < m)
            || schema["maximum"].as_f64().is_some_and(|m| n > m)
            || schema["exclusiveMinimum"].as_f64().is_some_and(|m| n <= m)
            || schema["exclusiveMaximum"].as_f64().is_some_and(|m| n >= m)
        {
            return Ok(false);
        }
        if let Some(m) = schema["multipleOf"].as_f64() {
            if m <= 0.0 {
                return Err("Invalid MCP multipleOf");
            }
            let quotient = n / m;
            if !quotient.is_finite() || (quotient - quotient.round()).abs() > 1e-10 {
                return Ok(false);
            }
        }
    }
    if let Some(a) = value.as_array() {
        if !size(a.len(), "minItems", "maxItems") {
            return Ok(false);
        }
        if schema["uniqueItems"] == true {
            for (i, v) in a.iter().enumerate() {
                for other in a.iter().take(i) {
                    budget(left, depth)?;
                    if v == other {
                        return Ok(false);
                    }
                }
            }
        }
        if let Some(items) = schema.get("items") {
            for v in a {
                if !matches(items, root, v, left, depth + 1)? {
                    return Ok(false);
                }
            }
        }
    }
    if let Some(object) = value.as_object() {
        if !size(object.len(), "minProperties", "maxProperties") {
            return Ok(false);
        }
        if schema["required"].as_array().is_some_and(|a| {
            a.iter()
                .any(|key| !key.as_str().is_some_and(|key| object.contains_key(key)))
        }) {
            return Ok(false);
        }
        for (key, v) in object {
            if let Some(property) = schema["properties"].get(key) {
                if !matches(property, root, v, left, depth + 1)? {
                    return Ok(false);
                }
            } else if let Some(additional) = schema.get("additionalProperties") {
                if !matches(additional, root, v, left, depth + 1)? {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}
pub(crate) fn validate(schema: &Value, arguments: &Value) -> Result<(), &'static str> {
    let mut schema_budget = LIMIT;
    let mut evaluation_budget = LIMIT;
    supported(schema, &mut schema_budget, 0)?;
    if matches(schema, schema, arguments, &mut evaluation_budget, 0)? {
        Ok(())
    } else {
        Err("MCP arguments do not match the exact tool schema; no tool was called")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_missing_wrong_type_and_additional_arguments() {
        let schema = json!({"type":"object","required":["name"],"additionalProperties":false,"properties":{"name":{"type":"string"},"count":{"type":"integer","minimum":1}}});
        assert!(validate(&schema, &json!({"name":"ok","count":2})).is_ok());
        for invalid in [
            json!({}),
            json!({"name":1}),
            json!({"name":"ok","extra":true}),
            json!({"name":"ok","count":0}),
            json!({"name":"ok","count":1.5}),
        ] {
            assert!(validate(&schema, &invalid).is_err());
        }
    }
    #[test]
    fn supports_bounded_local_refs_and_rejects_unknown_keywords() {
        let schema = json!({"type":"object","$defs":{"name":{"type":"string","minLength":2}},"properties":{"name":{"$ref":"#/$defs/name"}}});
        assert!(validate(&schema, &json!({"name":"ok"})).is_ok());
        assert!(validate(&schema, &json!({"name":"x"})).is_err());
        assert!(validate(&json!({"type":"string","pattern":".*"}), &json!("ok")).is_err());
        assert!(validate(&json!({"$ref":"#"}), &json!({})).is_err());
        assert!(validate(&json!({"$ref":"https://example.test/schema"}), &json!({})).is_err());
    }
}
