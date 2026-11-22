//! Plain `git` for a test fixture's own calls (setup and assertions), isolated
//! from the caller: no inherited `GIT_*` variable (a hook or caller may export
//! `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and the like, which would
//! point a fixture's reads or writes at another repository) and no system or
//! global config (a global `core.hooksPath` or `commit.gpgsign` must not judge
//! or change these repositories). Variables a caller sets afterwards apply.

use std::process::Command;

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

pub fn scratch_git() -> Command {
    let mut command = Command::new("git");
    scrub_git_env(&mut command);
    command
}

/// The same isolation for another Git binary.
pub fn scrub_git_env(command: &mut Command) -> &mut Command {
    for (name, _) in std::env::vars_os() {
        // Windows variable names are case-insensitive.
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
}
