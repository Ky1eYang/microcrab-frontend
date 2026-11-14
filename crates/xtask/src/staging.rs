//! Publish complete plugin artifacts and clean only invocation-owned staging files.
use std::{
    error::Error,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub(super) fn execute(command: &mut Command, stage: &str) -> Result<()> {
    // Inherit diagnostics; metadata is the only structured child-output capture.
    let status = command
        .status()
        .map_err(|error| format!("{stage}: {error}"))?;
    if !status.success() {
        return Err(format!("{stage} failed ({status})").into());
    }
    Ok(())
}

pub(super) struct Staged {
    pub(super) path: PathBuf,
}
impl Staged {
    pub(super) fn new(destination: &Path) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let parent = destination
            .parent()
            .ok_or("output needs a parent directory")?;
        fs::create_dir_all(parent)?;
        let name = destination
            .file_name()
            .ok_or("output needs a filename")?
            .to_string_lossy();
        let path = parent.join(format!(
            ".{name}.xtask-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        Ok(Self { path })
    }
    pub(super) fn publish(&self, destination: &Path) -> Result<()> {
        // Same-directory rename replaces a complete file; multiple outputs are independent.
        fs::rename(&self.path, destination)?;
        Ok(())
    }
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
