//! Frontend resource tasks; child commands inherit the supported Rust toolchain.
mod artifact_kind;
mod browser_host;
mod build_client_plugins;
mod staging;
use std::{error::Error, process::ExitCode};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}
fn run() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("browser-host") => browser_host::run(args),
        Some("build-client-plugins") => build_client_plugins::run(args),
        Some("--help" | "-h") | None => {
            build_client_plugins::help();
            println!();
            browser_host::help();
            Ok(())
        }
        Some(other) => Err(format!("unknown task {other:?}; use cargo xtask --help").into()),
    }
}
