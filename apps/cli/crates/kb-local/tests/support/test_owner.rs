//! Test-only process owner. A drained receipt authorizes namespace deletion.
//! Linux adopts orphans. Other Unix hosts require group/session escapes to use
//! --escape-{group,session}: the broker spawns them as its own waitable children.
//! No PID snapshots, inherited-output heuristic, or post-reap group signals.
#![allow(unsafe_code)] // User-authorized test owner; FFI stays in the OS modules.

use std::{ffi::OsString, io, path::Path, process::Command};

#[cfg(unix)]
#[path = "test_owner_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "test_owner_windows.rs"]
mod platform;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let result = platform::run(&args);
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "test owner: {error}");
            125
        }
    };
    std::process::exit(code);
}

fn command(args: &[OsString]) -> io::Result<Command> {
    let mut command = Command::new(
        args.first()
            .ok_or_else(|| io::Error::other("missing command"))?,
    );
    command.args(&args[1..]);
    Ok(command)
}

fn receipt(root: &Path, name: &str, value: impl AsRef<[u8]>) -> io::Result<()> {
    let temporary = root.join(format!("{name}.pending"));
    std::fs::write(&temporary, value)?;
    std::fs::rename(temporary, root.join(name))
}
