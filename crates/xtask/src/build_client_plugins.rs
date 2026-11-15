//! Build browser client Components separately from executable Agent artifacts.
//! All selected packages share one locked/offline Cargo build; installation
//! publishes immutable byte identities before replacing the discovery pointer.
use crate::{
    artifact_kind::{self, Kind},
    staging::{Staged, execute},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    error::Error,
    fs,
    path::PathBuf,
    process::Command,
};
use wasmparser::{Encoding, Parser, Payload, Validator};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const TARGET: &str = "wasm32-unknown-unknown";

pub(crate) fn help() {
    println!(
        "cargo xtask build-client-plugins [--release | --debug] [--validate]\n\
              \x20                                 [--only PACKAGE[,PACKAGE]] [--install | --install-dir PATH]\n\
              Build actual client-plugin Components in one locked/offline Cargo graph.\n\
              Install to frontend/public/plugins/<id>/<sha256>/plugin.wasm and current.json.\n\
              Requires the current Rust toolchain's wasm32-unknown-unknown target and wasm-tools."
    );
}
#[derive(Default, Debug)]
struct Options {
    release: bool,
    validate: bool,
    only: BTreeSet<String>,
    install: Option<PathBuf>,
}
fn parse(mut args: impl Iterator<Item = String>) -> Result<Option<Options>> {
    let mut options = Options::default();
    let mut profile = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--release" | "--debug" => {
                let release = arg == "--release";
                if profile.is_some_and(|old| old != release) {
                    return Err("--release and --debug cannot be combined".into());
                }
                profile = Some(release);
                options.release = release;
            }
            "--validate" => options.validate = true,
            "--install" => {
                options
                    .install
                    .get_or_insert_with(|| "frontend/public/plugins".into());
            }
            "--install-dir" | "--only" => {
                let value = args
                    .next()
                    .filter(|v| !v.is_empty() && !v.starts_with('-'))
                    .ok_or_else(|| format!("{arg} requires a value"))?;
                if arg == "--install-dir" {
                    options.install = Some(value.into());
                } else {
                    for name in value.split(',') {
                        if name.is_empty() {
                            return Err("--only contains an empty package name".into());
                        }
                        options.only.insert(name.into());
                    }
                }
            }
            _ => return Err(format!("unknown build-client-plugins argument {arg:?}").into()),
        }
    }
    Ok(Some(options))
}
#[derive(Debug)]
struct Plugin {
    package: String,
    module: String,
    component: String,
    id: String,
    default_enabled: bool,
    supersedes: Vec<String>,
}
fn portable_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn discover(metadata: &Value, selected: &BTreeSet<String>) -> Result<Vec<Plugin>> {
    let members: BTreeSet<_> = metadata["workspace_members"]
        .as_array()
        .ok_or("workspace_members missing")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let mut plugins = Vec::new();
    let mut ids = BTreeSet::new();
    let mut components = BTreeSet::new();
    for package in metadata["packages"].as_array().ok_or("packages missing")? {
        if !package["id"]
            .as_str()
            .is_some_and(|id| members.contains(id))
        {
            continue;
        }
        for target in package["targets"]
            .as_array()
            .ok_or("package targets missing")?
        {
            if !target["crate_types"]
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind == "cdylib"))
            {
                continue;
            }
            // Classify before selection: unknown metadata must fail even when a
            // caller selected another package, and Agents never enter this task.
            if artifact_kind::classify(package)? != Kind::ClientPlugin {
                continue;
            }
            let declaration = &package["metadata"]["microcrab"];
            let id = declaration["plugin-id"]
                .as_str()
                .filter(|id| portable_name(id))
                .ok_or("client-plugin requires a portable plugin-id")?;
            let component = declaration["component-name"]
                .as_str()
                .filter(|name| portable_name(name))
                .ok_or("client-plugin requires a portable component-name")?;
            if !ids.insert(id) || !components.insert(component) {
                return Err(format!("duplicate client-plugin id or component name: {id}").into());
            }
            let default_enabled = declaration["default-enabled"]
                .as_bool()
                .ok_or("client-plugin requires boolean default-enabled")?;
            let supersedes = match declaration.get("supersedes") {
                None => Vec::new(),
                Some(value) => {
                    let hashes = value
                        .as_array()
                        .filter(|hashes| hashes.len() <= 16)
                        .ok_or("client-plugin supersedes must be an array of at most 16 hashes")?;
                    hashes
                        .iter()
                        .map(|hash| {
                            hash.as_str()
                                .filter(|hash| {
                                    hash.len() == 64
                                        && hash.bytes().all(|b| {
                                            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                                        })
                                })
                                .map(str::to_owned)
                                .ok_or_else(|| {
                                    "client-plugin supersedes entries must be lowercase SHA-256 hashes"
                                        .into()
                                })
                        })
                        .collect::<Result<Vec<_>>>()?
                }
            };
            plugins.push(Plugin {
                package: package["name"]
                    .as_str()
                    .ok_or("package name missing")?
                    .into(),
                module: target["name"].as_str().ok_or("target name missing")?.into(),
                component: component.into(),
                id: id.into(),
                default_enabled,
                supersedes,
            });
        }
    }
    for name in selected {
        if !plugins.iter().any(|plugin| &plugin.package == name) {
            return Err(
                format!("--only package {name:?} is not a workspace client-plugin cdylib").into(),
            );
        }
    }
    plugins.retain(|plugin| selected.is_empty() || selected.contains(&plugin.package));
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    if plugins.is_empty() {
        return Err("no workspace client-plugin cdylibs found".into());
    }
    Ok(plugins)
}
fn installed_record(plugin: &Plugin, file: &str, sha256: &str) -> Value {
    let mut record = json!({"id":plugin.id,"file":file,"sha256":sha256,"default_enabled":plugin.default_enabled});
    if !plugin.supersedes.is_empty() {
        record["supersedes"] = json!(plugin.supersedes);
    }
    record
}
pub(crate) fn run(args: impl Iterator<Item = String>) -> Result<()> {
    let Some(options) = parse(args)? else {
        help();
        return Ok(());
    };
    let caller = std::env::current_dir()?;
    let root = crate::workspace::root()?;
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let output = Command::new(&cargo)
        .current_dir(&root)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--no-deps",
            "--locked",
            "--offline",
        ])
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let metadata: Value = serde_json::from_slice(&output.stdout)?;
    let plugins = discover(&metadata, &options.only)?;
    let target = PathBuf::from(
        metadata["target_directory"]
            .as_str()
            .ok_or("target_directory missing")?,
    );
    let mut build = Command::new(cargo);
    build
        .current_dir(&root)
        .args(["build", "--locked", "--offline", "--target", TARGET]);
    if options.release {
        build.arg("--release");
    }
    for plugin in &plugins {
        build.arg("-p").arg(&plugin.package);
    }
    execute(&mut build, "client-plugin Cargo build")?;
    let mut outputs = Vec::new();
    for plugin in &plugins {
        let module = target
            .join(TARGET)
            .join(if options.release { "release" } else { "debug" })
            .join(format!("{}.wasm", plugin.module));
        let destination = target
            .join("client-plugins")
            .join(format!("{}.wasm", plugin.component));
        let stage = Staged::new(&destination)?;
        let mut convert = Command::new("wasm-tools");
        convert
            .args(["component", "new"])
            .arg(module)
            .arg("-o")
            .arg(&stage.path);
        execute(&mut convert, "client-plugin component conversion")?;
        let bytes = fs::read(&stage.path)?;
        if options.validate || options.install.is_some() {
            validate_component(&bytes)?;
        }
        outputs.push((plugin, stage, destination, bytes));
    }
    for (_, stage, destination, _) in &outputs {
        stage.publish(destination)?;
        println!("client plugin: {}", destination.display());
    }
    if let Some(directory) = options.install {
        let directory = caller.join(directory);
        let mut records = Vec::new();
        for (plugin, _, _, bytes) in &outputs {
            let sha256 = format!("{:x}", Sha256::digest(bytes));
            let file = format!("{}/{sha256}/plugin.wasm", plugin.id);
            let destination = directory.join(&file);
            if destination.exists() {
                if fs::read(&destination)? != *bytes {
                    return Err(format!(
                        "immutable plugin bytes differ: {}",
                        destination.display()
                    )
                    .into());
                }
            } else {
                let stage = Staged::new(&destination)?;
                fs::write(&stage.path, bytes)?;
                stage.publish(&destination)?;
            }
            records.push(installed_record(plugin, &file, &sha256));
        }
        let pointer = directory.join("current.json");
        let stage = Staged::new(&pointer)?;
        fs::write(
            &stage.path,
            serde_json::to_vec_pretty(&json!({"version":1,"plugins":records}))?,
        )?;
        stage.publish(&pointer)?;
        println!("installed client plugins: {}", pointer.display());
    }
    Ok(())
}
fn validate_component(bytes: &[u8]) -> Result<()> {
    if !matches!(
        Parser::new(0).parse_all(bytes).next(),
        Some(Ok(Payload::Version {
            encoding: Encoding::Component,
            ..
        }))
    ) {
        return Err("client-plugin output is not a Component".into());
    }
    Validator::new().validate_all(bytes)?;
    Ok(())
}
#[cfg(test)]
mod tests;
