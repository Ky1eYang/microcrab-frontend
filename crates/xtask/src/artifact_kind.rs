//! Classify build outputs before selecting a build pipeline. A cdylib alone is
//! not an Agent: browser/FFI libraries must never enter component installation.
use serde_json::Value;
use std::error::Error;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Agent,
    FrontendHost,
    ClientPlugin,
    NativeLibrary,
}

pub(crate) fn classify(package: &Value) -> Result<Kind, Box<dyn Error>> {
    let metadata = &package["metadata"]["microcrab"];
    match metadata["artifact-kind"].as_str() {
        Some("agent") => Ok(Kind::Agent),
        Some("frontend-host") => Ok(Kind::FrontendHost),
        Some("client-plugin") => Ok(Kind::ClientPlugin),
        Some("native-library") => Ok(Kind::NativeLibrary),
        Some(other) => Err(format!("unknown microcrab artifact-kind {other:?}").into()),
        // The established component-name declaration is an explicit Agent marker.
        // Keep it authoritative for existing guests without inferring from cdylib.
        None if !metadata["artifact-kind"].is_null() => {
            Err("microcrab artifact-kind must be a string".into())
        }
        None if metadata["component-name"].is_string() => Ok(Kind::Agent),
        None => Err(format!(
            "cdylib package {} requires package.metadata.microcrab.artifact-kind (agent, frontend-host, client-plugin, native-library)",
            package["name"].as_str().unwrap_or("<unnamed>")
        ).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classification_is_explicit_and_browser_never_becomes_agent() {
        assert_eq!(
            classify(&json!({"metadata":{"microcrab":{"component-name":"coding"}}})).unwrap(),
            Kind::Agent
        );
        assert_eq!(classify(&json!({"metadata":{"microcrab":{"artifact-kind":"frontend-host", "component-name":"must-not-install"}}})).unwrap(), Kind::FrontendHost);
        assert_eq!(
            classify(&json!({"metadata":{"microcrab":{"artifact-kind":"native-library"}}}))
                .unwrap(),
            Kind::NativeLibrary
        );
        assert_eq!(classify(&json!({"metadata":{"microcrab":{"artifact-kind":"client-plugin", "component-name":"must-not-install"}}})).unwrap(), Kind::ClientPlugin);
        assert!(classify(&json!({"name":"unclassified"})).is_err());
        assert!(classify(&json!({"metadata":{"microcrab":{"artifact-kind":"typo"}}})).is_err());
    }
}
