use super::*;

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    assets: PathBuf,
    install: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "microcrab-browser-artifacts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let assets = root.join("assets");
        let install = root.join("installed");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&assets).unwrap();
        for name in REQUIRED_SOURCES {
            fs::write(source.join(name), "// test source\n").unwrap();
        }
        let wheel = b"PK\x03\x04test fixture package";
        let lock = json!({"info":{"version":"0.29.3"},"packages":{
            "micropip":{"file_name":"micropip.whl","sha256":digest(wheel),"depends":["packaging"]},
            "packaging":{"file_name":"packaging.whl","sha256":digest(wheel),"depends":[]}
        }});
        for name in ["pyodide.mjs", "pyodide.asm.mjs"] {
            fs::write(assets.join(name), "// test JS fixture\n").unwrap();
        }
        fs::write(assets.join("pyodide.asm.wasm"), module(REQUIRED_EXPORTS)).unwrap();
        fs::write(
            assets.join("python_stdlib.zip"),
            b"PK\x03\x04test stdlib fixture",
        )
        .unwrap();
        fs::write(
            assets.join("pyodide-lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();
        for name in ["micropip.whl", "packaging.whl"] {
            fs::write(assets.join(name), wheel).unwrap();
        }
        let fixture = Self {
            root,
            source,
            assets,
            install,
        };
        fixture.repin();
        fixture
    }
    fn repin(&self) {
        let mut pins = serde_json::Map::new();
        for entry in fs::read_dir(&self.assets).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_str().unwrap();
            if name != "browser-host-assets.json" {
                pins.insert(name.to_owned(), digest(&fs::read(path).unwrap()).into());
            }
        }
        fs::write(self.assets.join("browser-host-assets.json"),serde_json::to_vec(&json!({"schema":1,"wasmsh_version":VERSION,"pyodide_version":"0.29.3","lock_metadata_version":"0.29.3","files":pins})).unwrap()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

// Minimal actual core module: each named function has an empty () -> () body.
// This only tests export discovery/validation, never Python execution readiness.
fn module(exports: &[&str]) -> Vec<u8> {
    module_with_body(exports, &[0, 0x0b])
}
fn module_with_body(exports: &[&str], body: &[u8]) -> Vec<u8> {
    fn leb(mut n: usize) -> Vec<u8> {
        let mut b = Vec::new();
        loop {
            let byte = (n & 127) as u8;
            n >>= 7;
            b.push(byte | if n > 0 { 128 } else { 0 });
            if n == 0 {
                break;
            }
        }
        b
    }
    fn section(out: &mut Vec<u8>, id: u8, payload: Vec<u8>) {
        out.push(id);
        out.extend(leb(payload.len()));
        out.extend(payload);
    }
    let mut out = b"\0asm\x01\0\0\0".to_vec();
    section(&mut out, 1, vec![1, 0x60, 0, 0]);
    let mut funcs = leb(exports.len());
    funcs.extend(vec![0; exports.len()]);
    section(&mut out, 3, funcs);
    let mut names = leb(exports.len());
    for (index, name) in exports.iter().enumerate() {
        names.extend(leb(name.len()));
        names.extend(name.as_bytes());
        names.push(0);
        names.extend(leb(index));
    }
    section(&mut out, 7, names);
    let mut code = leb(exports.len());
    for _ in exports {
        code.extend(leb(body.len()));
        code.extend_from_slice(body);
    }
    section(&mut out, 10, code);
    out
}

#[test]
fn rejects_missing_paths_duplicate_options_and_unsafe_names() {
    for args in [
        vec![],
        vec!["--assets-dir"],
        vec!["--assets-dir", "--source-dir"],
        vec!["--assets-dir", "a", "--assets-dir", "b"],
        vec!["--download"],
    ] {
        assert!(parse(args.into_iter().map(str::to_owned)).is_err());
    }
    for path in [
        "../escape",
        "a/../b",
        "C:/asset",
        "/absolute",
        "a\\b",
        "a//b",
        "a/%2e%2e/b",
        "a?b",
    ] {
        assert!(safe_relative(path).is_err(), "{path}");
    }
    assert!(safe_relative("wheels/micropip.whl").is_ok());
}
#[test]
fn actual_wasm_must_validate_and_export_all_runtime_functions() {
    assert!(validate_wasm(&module(REQUIRED_EXPORTS)).is_ok());
    assert!(validate_wasm(&module(&REQUIRED_EXPORTS[..2])).is_err());
    assert!(
        validate_wasm(b"wasmsh_runtime_new wasmsh_runtime_handle_json wasmsh_runtime_free_string")
            .is_err()
    );
    assert!(validate_wasm(b"\0asm\x01\0\0\0").is_err());
}
#[test]
fn frontend_runtime_accepts_legacy_try_catch_without_relaxing_export_checks() {
    // local decls; try void; nop; catch_all; nop; end try; end function.
    let body = [0, 0x06, 0x40, 0x01, 0x19, 0x01, 0x0b, 0x0b];
    let bytes = module_with_body(REQUIRED_EXPORTS, &body);
    assert!(Validator::new().validate_all(&bytes).is_err());
    assert!(validate_wasm(&bytes).is_ok());
    assert!(validate_wasm(&module_with_body(&REQUIRED_EXPORTS[..2], &body)).is_err());
}
#[test]
fn canonical_json_sorts_nested_keys_and_retains_array_order() {
    let value: Value = serde_json::from_str(r#"{"z":[{"b":2,"a":1},0],"a":true}"#).unwrap();
    assert_eq!(
        canonical_bytes(&value).unwrap(),
        br#"{"a":true,"z":[{"a":1,"b":2},0]}"#
    );
}
#[test]
fn reproducibility_tracks_every_deployed_byte_and_ignores_pin_whitespace() {
    let f = Fixture::new();
    let a = prepare(&f.source, &f.assets).unwrap();
    let pins: Value =
        serde_json::from_slice(&fs::read(f.assets.join("browser-host-assets.json")).unwrap())
            .unwrap();
    fs::write(
        f.assets.join("browser-host-assets.json"),
        serde_json::to_vec_pretty(&pins).unwrap(),
    )
    .unwrap();
    let b = prepare(&f.source, &f.assets).unwrap();
    assert_eq!(a.hash, b.hash);
    assert_eq!(a.manifest, b.manifest);
    fs::write(f.source.join("supervisor.mjs"), "// changed source").unwrap();
    assert_ne!(a.hash, prepare(&f.source, &f.assets).unwrap().hash);
}
#[test]
fn mismatched_pins_missing_custom_runtime_and_missing_lock_closure_fail() {
    let f = Fixture::new();
    fs::write(f.assets.join("pyodide.mjs"), "changed").unwrap();
    assert!(prepare(&f.source, &f.assets).is_err());
    f.repin();
    fs::write(f.assets.join("pyodide.asm.wasm"), module(&[])).unwrap();
    f.repin();
    assert!(prepare(&f.source, &f.assets).is_err());
    fs::write(f.assets.join("pyodide.asm.wasm"), module(REQUIRED_EXPORTS)).unwrap();
    fs::remove_file(f.assets.join("packaging.whl")).unwrap();
    f.repin();
    assert!(prepare(&f.source, &f.assets).is_err());
}
#[test]
fn mismatched_lock_metadata_cannot_be_accepted_by_a_provenance_claim_alone() {
    let f = Fixture::new();
    let artifact = prepare(&f.source, &f.assets).unwrap();
    let pins = json!({"source_archive_sha256":OFFICIAL_ARCHIVE_SHA256});
    assert!(
        validate_lock_metadata(&pins, &artifact.files, PYODIDE_VERSION, "0.28.0.dev0").is_err()
    );
    assert!(
        validate_lock_metadata(&pins, &artifact.files, PYODIDE_VERSION, PYODIDE_VERSION).is_ok()
    );
    assert!(validate_lock_metadata(&pins, &artifact.files, PYODIDE_VERSION, "unknown").is_err());
}
#[test]
fn official_lock_can_retain_uninstalled_optional_packages() {
    let f = Fixture::new();
    let lock_path = f.assets.join("pyodide-lock.json");
    let mut lock: Value = serde_json::from_slice(&fs::read(&lock_path).unwrap()).unwrap();
    lock["packages"]["optional"] =
        json!({"file_name":"optional.whl", "sha256":digest(b"not installed"), "depends":[]});
    fs::write(&lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    f.repin();
    assert!(prepare(&f.source, &f.assets).is_ok());
    fs::rename(
        f.assets.join("pyodide.asm.mjs"),
        f.assets.join("pyodide.asm.js"),
    )
    .unwrap();
    f.repin();
    assert!(prepare(&f.source, &f.assets).is_ok());
    fs::write(f.assets.join("optional.whl"), b"not installed").unwrap();
    lock["packages"]["optional"]["depends"] = json!(["missing_dependency"]);
    fs::write(&lock_path, serde_json::to_vec(&lock).unwrap()).unwrap();
    f.repin();
    assert!(prepare(&f.source, &f.assets).is_err());
}
#[test]
fn publication_is_idempotent_and_failed_candidate_retains_current() {
    let f = Fixture::new();
    let a = prepare(&f.source, &f.assets).unwrap();
    publish(&a, &f.install).unwrap();
    publish(&a, &f.install).unwrap();
    let current = fs::read(f.install.join("current.json")).unwrap();
    fs::write(f.source.join("supervisor.mjs"), "// new artifact").unwrap();
    let b = prepare(&f.source, &f.assets).unwrap();
    fs::create_dir(f.install.join(&b.hash)).unwrap();
    fs::write(
        f.install.join(&b.hash).join("manifest.json"),
        "corrupt immutable artifact",
    )
    .unwrap();
    assert!(publish(&b, &f.install).is_err());
    assert_eq!(current, fs::read(f.install.join("current.json")).unwrap());
    fs::write(f.install.join(&a.hash).join("supervisor.mjs"), "tampered").unwrap();
    assert!(publish(&a, &f.install).is_err());
}
