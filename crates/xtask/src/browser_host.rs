//! Deliver browser Host sources with an already prepared, pinned runtime.
//! Validation is offline. A complete immutable directory is published before the
//! current pointer changes; failed staging preserves the last current pointer.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use wasmparser::{ExternalKind, Parser, Payload, Validator, WasmFeatures};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const VERSION: &str = "0.5.1";
const PYODIDE_VERSION: &str = "0.29.3";
// Official wasmsh 0.5.1 custom distribution retains an older lock metadata
// version. This exact byte-pinned exception is provenance, not a generic bypass
// of the Pyodide loader's runtime compatibility checks.
const OFFICIAL_ARCHIVE_SHA256: &str =
    "b2a267cad1ae74dfb1216c90c9861c33ae7bb49c71abd20e7e16adc60138b2b0";
const OFFICIAL_LOCK_SHA256: &str =
    "3256ffc76388de0e37f4b34d42ab484268d1afc675179ff97b2a5bb14f84ccac";
const OFFICIAL_WASM_SHA256: &str =
    "d90e175a4c3b81588d0dee734a4808dcaf23765322f07ed78d20ee43c70fce14";
const REQUIRED_EXPORTS: &[&str] = &[
    "wasmsh_runtime_new",
    "wasmsh_runtime_handle_json",
    "wasmsh_runtime_free_string",
    "wasmsh_runtime_free",
];
const REQUIRED_SOURCES: &[&str] = &[
    "supervisor.mjs",
    "workspace.mjs",
    "mutations.mjs",
    "network.mjs",
    "capture.mjs",
    "receipts.mjs",
    "realm.html",
    "execution-worker.mjs",
];
const REQUIRED_ASSETS: &[&str] = &[
    "pyodide.mjs",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
];

pub(crate) fn help() {
    println!(
        "cargo xtask browser-host --assets-dir PATH [--source-dir PATH] [--install-dir PATH]\n\
         Validate prepared, pinned local Pyodide/wasmsh assets and install the complete\n\
         browser Host under frontend/public/browser-host/<hash> plus current.json.\n\
         Relative paths resolve from the workspace root. No downloads or builds."
    );
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    assets: PathBuf,
    source: PathBuf,
    install: PathBuf,
}
fn parse(mut args: impl Iterator<Item = String>) -> Result<Option<Options>> {
    let mut assets = None;
    let mut source = PathBuf::from("crates/host/frontend/browser");
    let mut install = PathBuf::from("frontend/public/browser-host");
    let mut seen = BTreeSet::new();
    while let Some(arg) = args.next() {
        if arg == "-h" || arg == "--help" {
            return Ok(None);
        }
        if !seen.insert(arg.clone()) {
            return Err(format!("duplicate option {arg}").into());
        }
        match arg.as_str() {
            "--assets-dir" => assets = Some(value(&mut args, &arg)?.into()),
            "--source-dir" => source = value(&mut args, &arg)?.into(),
            "--install-dir" => install = value(&mut args, &arg)?.into(),
            _ => return Err(format!("unknown browser-host argument {arg:?}").into()),
        }
    }
    Ok(Some(Options { assets: assets.ok_or("--assets-dir is required; prepare a pinned local custom wasmsh 0.5.1 Pyodide distribution first")?, source, install }))
}
fn value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    let value = args
        .next()
        .ok_or_else(|| format!("{flag} requires a value"))?;
    if value.is_empty() || value.starts_with('-') {
        return Err(format!("{flag} requires a nonempty value").into());
    }
    Ok(value)
}

pub(crate) fn run(args: impl Iterator<Item = String>) -> Result<()> {
    let Some(options) = parse(args)? else {
        help();
        return Ok(());
    };
    let root = crate::workspace::root()?;
    let source = root.join(options.source);
    let assets = root.join(options.assets);
    let install = root.join(options.install);
    let artifact = prepare(&source, &assets)?;
    publish(&artifact, &install)?;
    println!(
        "installed browser Host {}",
        install.join(&artifact.hash).display()
    );
    Ok(())
}

struct Artifact {
    files: BTreeMap<String, Vec<u8>>,
    hash: String,
    manifest: Vec<u8>,
}
fn prepare(source: &Path, assets: &Path) -> Result<Artifact> {
    let pin_path = assets.join("browser-host-assets.json");
    let pins: Value = serde_json::from_slice(&fs::read(&pin_path).map_err(|e| format!(
        "cannot read prepared local asset manifest {}: {e}; supply --assets-dir with custom wasmsh {VERSION} Pyodide assets and SHA-256 pins", pin_path.display()
    ))?)?;
    if pins["schema"] != 1 || pins["wasmsh_version"] != VERSION {
        return Err("asset manifest must pin schema 1 and wasmsh_version 0.5.1".into());
    }
    let version = pins["pyodide_version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("asset manifest must pin pyodide_version")?;
    if version != PYODIDE_VERSION {
        return Err(format!(
            "wasmsh {VERSION} requires pinned Pyodide {PYODIDE_VERSION}, got {version}"
        )
        .into());
    }
    let lock_version = pins["lock_metadata_version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("asset manifest must explicitly pin lock_metadata_version")?;
    let pinned = pins["files"]
        .as_object()
        .ok_or("asset manifest files must map local relative paths to SHA-256 digests")?;
    let mut files = BTreeMap::new();
    collect_sources(source, "", &mut files)?;
    for required in REQUIRED_SOURCES {
        if !files.contains_key(*required) {
            return Err(format!("missing browser source {required}").into());
        }
    }
    // Read each asset once. The exact validated bytes are hashed and published,
    // so concurrent changes to input files cannot alter the delivered artifact.
    let mut portable_names = BTreeSet::new();
    for (relative, expected) in pinned {
        safe_relative(relative)?;
        if relative == "browser-host-assets.json" {
            return Err("asset manifest cannot pin itself".into());
        }
        if !portable_names.insert(relative.to_ascii_lowercase()) {
            return Err(format!("case-colliding pinned asset {relative}").into());
        }
        let path = assets.join(relative);
        reject_symlink_path(assets, relative)?;
        let bytes = fs::read(&path)
            .map_err(|e| format!("missing pinned local asset {}: {e}", path.display()))?;
        let expected = expected
            .as_str()
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .ok_or_else(|| format!("invalid lowercase SHA-256 pin for {relative}"))?;
        if bytes.is_empty() {
            return Err(format!("empty pinned asset {relative}").into());
        }
        if digest(&bytes) != expected {
            return Err(format!("SHA-256 mismatch for pinned asset {relative}").into());
        }
        files.insert(format!("pyodide/{relative}"), bytes);
    }
    for required in REQUIRED_ASSETS {
        if !pinned.contains_key(*required) {
            return Err(format!("missing required pinned asset {required}").into());
        }
    }
    if !pinned.contains_key("pyodide.asm.mjs") && !pinned.contains_key("pyodide.asm.js") {
        return Err("missing pinned Pyodide asm loader (pyodide.asm.mjs or pyodide.asm.js)".into());
    }
    validate_wasm(&files["pyodide/pyodide.asm.wasm"])?;
    validate_lock_metadata(&pins, &files, version, lock_version)?;
    validate_lock(&files, lock_version)?;
    // Include provenance pins in the identity too. Canonical JSON removes input
    // whitespace/order differences without losing any declared provenance field.
    files.insert(
        "pyodide/browser-host-assets.json".into(),
        canonical_bytes(&pins)?,
    );
    if files.len() > 2048 || files.values().any(|bytes| bytes.len() > 128 * 1024 * 1024) {
        return Err("browser artifact exceeds loader limits (2048 files, 128 MiB per file)".into());
    }
    if files
        .keys()
        .map(|path| path.to_ascii_lowercase())
        .collect::<BTreeSet<_>>()
        .len()
        != files.len()
    {
        return Err("browser source and asset paths have case collisions".into());
    }
    let records: Vec<Value> = files
        .iter()
        .map(|(path, bytes)| json!({"path":path,"sha256":digest(bytes),"size":bytes.len()}))
        .collect();
    let hash = digest(&canonical_bytes(&Value::Array(records.clone()))?);
    let manifest = serde_json::to_vec_pretty(&canonical(&json!({
        "schema":1, "kind":"browser-host", "wasmsh_version":VERSION,
        "pyodide_version":version, "lock_metadata_version":lock_version, "hash":hash,
        "base_url":format!("/browser-host/{hash}/"), "entry":"supervisor.mjs",
        "realm":"realm.html", "pyodide":"pyodide/pyodide.mjs", "files":records,
    })))?;
    Ok(Artifact {
        files,
        hash,
        manifest,
    })
}
fn canonical_bytes(value: &Value) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&canonical(value))?)
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe_relative(relative: &str) -> Result<()> {
    // Require one portable URL/file spelling, including on Windows. Reject drive
    // prefixes and encoded URL tricks before joining or exposing a manifest path.
    if relative.is_empty()
        || !relative
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b))
        || relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with('.'))
        || Path::new(relative)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(format!("unsafe artifact path {relative:?}").into());
    }
    Ok(())
}
fn reject_symlink_path(base: &Path, relative: &str) -> Result<()> {
    let mut path = base.to_owned();
    for part in relative.split('/') {
        path.push(part);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(format!("symlink is not a reproducible asset: {}", path.display()).into());
        }
    }
    Ok(())
}
fn collect_sources(
    directory: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    for entry in fs::read_dir(directory).map_err(|e| {
        format!(
            "missing browser source directory {}: {e}",
            directory.display()
        )
    })? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "browser source path must be UTF-8")?;
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        safe_relative(&relative)?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(format!("browser source symlink {relative} is unsupported").into());
        }
        if kind.is_dir() {
            collect_sources(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            // Only deployable sources belong here; tests/docs remain source-only.
            if ["mjs", "js", "html", "css", "json", "wasm"].contains(
                &entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or(""),
            ) && !relative.ends_with(".test.mjs")
            {
                if relative == "manifest.json" || relative.starts_with("pyodide/") {
                    return Err(format!("reserved browser source path {relative}").into());
                }
                let bytes = fs::read(entry.path())?;
                if bytes.is_empty() {
                    return Err(format!("empty browser source {relative}").into());
                }
                files.insert(relative, bytes);
            }
        } else {
            return Err(format!("unsupported browser source file type {relative}").into());
        }
    }
    Ok(())
}
fn validate_wasm(bytes: &[u8]) -> Result<()> {
    // The pinned Emscripten 4 runtime uses legacy try/catch instructions.
    // Preserve parser defaults for every other feature and keep this exception
    // confined to frontend runtime delivery, separate from Agent validation.
    let mut features = WasmFeatures::default();
    features.set(WasmFeatures::LEGACY_EXCEPTIONS, true);
    Validator::new_with_features(features)
        .validate_all(bytes)
        .map_err(|e| format!("invalid custom Pyodide WASM: {e}"))?;
    let mut exports = BTreeSet::new();
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::ExportSection(section) = payload? {
            for export in section {
                let export = export?;
                if export.kind == ExternalKind::Func {
                    exports.insert(export.name.to_owned());
                }
            }
        }
    }
    for required in REQUIRED_EXPORTS {
        if !exports.contains(*required) {
            return Err(format!("custom Pyodide WASM missing function export {required}; stock Pyodide cannot run wasmsh {VERSION}").into());
        }
    }
    Ok(())
}
fn validate_lock_metadata(
    pins: &Value,
    files: &BTreeMap<String, Vec<u8>>,
    runtime: &str,
    lock: &str,
) -> Result<()> {
    if runtime == lock {
        return Ok(());
    }
    if runtime == PYODIDE_VERSION
        && lock == "0.28.0.dev0"
        && pins["source_archive_sha256"].as_str() == Some(OFFICIAL_ARCHIVE_SHA256)
        && digest(&files["pyodide/pyodide-lock.json"]) == OFFICIAL_LOCK_SHA256
        && digest(&files["pyodide/pyodide.asm.wasm"]) == OFFICIAL_WASM_SHA256
    {
        return Ok(());
    }
    Err("runtime and lock metadata versions differ outside the byte-pinned official wasmsh 0.5.1 distribution; retain original bytes and supply verified provenance".into())
}
fn validate_lock(files: &BTreeMap<String, Vec<u8>>, version: &str) -> Result<()> {
    let lock: Value = serde_json::from_slice(&files["pyodide/pyodide-lock.json"])?;
    if lock["info"]["version"].as_str() != Some(version) {
        return Err("pyodide-lock.json version does not match pinned lock_metadata_version".into());
    }
    let packages = lock["packages"]
        .as_object()
        .ok_or("pyodide-lock.json missing packages")?;
    // The official lock may describe packages absent from the release archive.
    // Require the bootstrap closure and every additionally supplied lock package;
    // missing optional packages stay unavailable, with no fabricated lock hashes.
    let mut pending: Vec<String> = vec!["micropip".into(), "packaging".into()];
    for (name, package) in packages {
        if package["file_name"]
            .as_str()
            .is_some_and(|file| files.contains_key(&format!("pyodide/{file}")))
        {
            pending.push(name.to_owned());
        }
    }
    let mut checked = BTreeSet::new();
    while let Some(name) = pending.pop() {
        if !checked.insert(name.clone()) {
            continue;
        }
        let package = packages
            .get(&name)
            .ok_or_else(|| format!("Pyodide lock missing selected package {name}"))?;
        let file = package["file_name"]
            .as_str()
            .ok_or_else(|| format!("Pyodide package {name} missing file_name"))?;
        safe_relative(file)?;
        let bytes = files
            .get(&format!("pyodide/{file}"))
            .ok_or_else(|| format!("missing pinned local Pyodide package {name}: {file}"))?;
        if package["sha256"].as_str() != Some(digest(bytes).as_str()) {
            return Err(format!("Pyodide lock SHA-256 mismatch for {name}").into());
        }
        for dependency in package["depends"]
            .as_array()
            .ok_or_else(|| format!("Pyodide package {name} missing depends"))?
        {
            let dependency = dependency
                .as_str()
                .ok_or("Pyodide dependency must be a package name")?;
            pending.push(dependency.to_owned());
        }
    }
    Ok(())
}

fn publish(artifact: &Artifact, install: &Path) -> Result<()> {
    fs::create_dir_all(install)?;
    let destination = install.join(&artifact.hash);
    if destination.exists() {
        // Repeating identical input is idempotent, but corruption never heals
        // silently under an immutable content address.
        verify_existing(artifact, &destination)?;
    } else {
        let stage = Stage::directory(install, &artifact.hash)?;
        for (relative, bytes) in &artifact.files {
            let path = stage.path.join(relative);
            fs::create_dir_all(path.parent().ok_or("asset parent missing")?)?;
            fs::write(path, bytes)?;
        }
        fs::write(stage.path.join("manifest.json"), &artifact.manifest)?;
        fs::rename(&stage.path, &destination)?;
    }
    let current = Stage::file(install)?;
    let mut writer = OpenOptions::new().write(true).open(&current.path)?;
    writer.write_all(&artifact.manifest)?;
    writer.sync_all()?;
    drop(writer);
    fs::rename(&current.path, install.join("current.json"))?;
    Ok(())
}
fn verify_existing(artifact: &Artifact, destination: &Path) -> Result<()> {
    let mut actual = BTreeSet::new();
    inventory(destination, "", &mut actual)?;
    let mut expected: BTreeSet<_> = artifact.files.keys().cloned().collect();
    expected.insert("manifest.json".into());
    if actual != expected {
        return Err("existing immutable browser artifact file set differs".into());
    }
    if fs::read(destination.join("manifest.json"))? != artifact.manifest {
        return Err("existing immutable browser manifest differs".into());
    }
    for (relative, bytes) in &artifact.files {
        reject_symlink_path(destination, relative)?;
        if fs::read(destination.join(relative))? != *bytes {
            return Err(format!("existing immutable browser asset differs: {relative}").into());
        }
    }
    Ok(())
}
fn inventory(directory: &Path, prefix: &str, files: &mut BTreeSet<String>) -> Result<()> {
    if fs::symlink_metadata(directory)?.file_type().is_symlink() {
        return Err("immutable browser directory must not be a symlink".into());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "installed artifact path must be UTF-8")?;
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            inventory(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            files.insert(relative);
        } else {
            return Err("immutable browser artifact contains unsupported file type".into());
        }
    }
    Ok(())
}
struct Stage {
    path: PathBuf,
    directory: bool,
}
impl Stage {
    fn path(install: &Path, name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        install.join(format!(
            ".{name}.xtask-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn directory(install: &Path, hash: &str) -> Result<Self> {
        let path = Self::path(install, hash);
        fs::create_dir(&path)?;
        Ok(Self {
            path,
            directory: true,
        })
    }
    fn file(install: &Path) -> Result<Self> {
        let path = Self::path(install, "current");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Self {
            path,
            directory: false,
        })
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        // Only the unique file/directory exclusively created by this task is
        // removed; published directories are renamed out of this owned path.
        if self.directory {
            let _ = fs::remove_dir_all(&self.path);
        } else {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests;
