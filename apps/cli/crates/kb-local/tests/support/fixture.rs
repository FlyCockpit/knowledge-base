//! Real Git fixtures built with plumbing only (`hash-object`, raw tree bytes,
//! `commit-tree`, `update-ref`): no working tree is ever checked out, so
//! case-colliding or reserved names work identically on case-insensitive
//! macOS/Windows filesystems.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::Write;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use kb_client::types::KbId;
use kb_client::types::Sha;

#[path = "scratch_git.rs"]
mod scratch_git;
pub use scratch_git::{git_spelling, scratch_git};

// Probe the OS locks directly: try_lock_write can also return None while an
// unrelated store's spawn holds the process-wide admission registry.
#[cfg(unix)]
pub fn os_locks_available(root: &Path, kbs: &[KbId]) -> bool {
    let paths = std::iter::once(root.join("locks/store.lock")).chain(
        kbs.iter()
            .map(|kb| root.join("locks").join(format!("kb_{kb}.lock"))),
    );
    for path in paths {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .expect("existing lock file");
        match file.try_lock() {
            Ok(()) => file.unlock().expect("probe unlock"),
            Err(std::fs::TryLockError::WouldBlock) => return false,
            Err(std::fs::TryLockError::Error(error)) => panic!("lock probe: {error}"),
        }
    }
    true
}

pub const GITIGNORE: &[u8] = b"# kb managed\n";
pub const MANIFEST: &[u8] = b"{\"version\":1,\"entries\":[]}\n";
pub const INDEX: &[u8] = b"# Title\n\nBody\n";

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

#[path = "child_guard.rs"]
pub mod child_guard;
pub type ChildGuard = child_guard::ChildGuard;

pub struct Fixture {
    pub root: PathBuf,
    pub repo: PathBuf,
}

enum Node {
    File(String),
    Dir(BTreeMap<Vec<u8>, Node>),
}

impl Fixture {
    pub fn new(tag: &str) -> Fixture {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        // Canonical on Unix, as the CLI passes its resolved directories (the
        // macOS temp root sits behind the `/var` -> `private/var` link).
        let temp = std::env::temp_dir();
        #[cfg(unix)]
        let temp = temp.canonicalize().expect("canonical temp root");
        let root = temp.join(format!(
            "kb-local-git-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("fixture root");
        let fixture = Fixture {
            repo: root.join("repo.git"),
            root,
        };
        fixture.run_in(
            &fixture.root,
            &["init", "--quiet", "--bare", "repo.git"],
            None,
        );
        fixture
    }

    fn run_in(&self, cwd: &std::path::Path, args: &[&str], stdin: Option<&[u8]>) -> String {
        let mut command = scratch_git();
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "Fixture Author")
            .env("GIT_AUTHOR_EMAIL", "author@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture Committer")
            .env("GIT_COMMITTER_EMAIL", "committer@example.invalid")
            .env("GIT_AUTHOR_DATE", "1700000000 +0000")
            .env("GIT_COMMITTER_DATE", "1700000000 +0000")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = ChildGuard::spawn_direct(&mut command).expect("spawn git");
        if let Some(bytes) = stdin {
            let mut pipe = child.stdin.take().expect("stdin");
            pipe.write_all(bytes).expect("write stdin");
        }
        let out = child.wait_with_output().expect("git output");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .expect("utf8")
            .trim()
            .to_owned()
    }

    pub fn git(&self, args: &[&str]) -> String {
        let repo = git_spelling(&self.repo);
        let mut full = vec!["--git-dir", repo.to_str().expect("utf8 path")];
        full.extend_from_slice(args);
        self.run_in(&self.root, &full, None)
    }

    pub fn git_with_env(&self, args: &[&str], env: &[(&str, &str)]) -> String {
        let mut command = scratch_git();
        command
            .arg("--git-dir")
            .arg(git_spelling(&self.repo))
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null());
        for (k, v) in env {
            command.env(k, v);
        }
        let out = command.output().expect("git");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .expect("utf8")
            .trim()
            .to_owned()
    }

    pub fn blob(&self, bytes: &[u8]) -> String {
        let repo = git_spelling(&self.repo)
            .to_str()
            .expect("utf8 path")
            .to_owned();
        self.run_in(
            &self.root,
            &["--git-dir", &repo, "hash-object", "-w", "--stdin"],
            Some(bytes),
        )
    }

    /// Write a tree object with exactly these raw entries, in exactly this
    /// order (`--literally`: no fsck, so malformed trees are possible).
    pub fn raw_tree(&self, entries: &[(&str, &[u8], &str)]) -> String {
        let mut body = Vec::new();
        for (mode, name, sha) in entries {
            body.extend_from_slice(mode.as_bytes());
            body.push(b' ');
            body.extend_from_slice(name);
            body.push(0);
            body.extend_from_slice(&hex_to_bytes(sha));
        }
        let repo = git_spelling(&self.repo)
            .to_str()
            .expect("utf8 path")
            .to_owned();
        self.run_in(
            &self.root,
            &[
                "--git-dir",
                &repo,
                "hash-object",
                "-t",
                "tree",
                "-w",
                "--literally",
                "--stdin",
            ],
            Some(&body),
        )
    }

    /// Build a well-ordered nested tree of 100644 blobs from `path -> bytes`.
    pub fn tree(&self, files: &[(&str, &[u8])]) -> String {
        let mut blobs: BTreeMap<Vec<u8>, String> = BTreeMap::new();
        let mut root: BTreeMap<Vec<u8>, Node> = BTreeMap::new();
        for (path, content) in files {
            let sha = blobs
                .entry(content.to_vec())
                .or_insert_with(|| self.blob(content))
                .clone();
            let segments: Vec<&str> = path.split('/').collect();
            let mut dir = &mut root;
            for segment in &segments[..segments.len() - 1] {
                let node = dir
                    .entry(segment.as_bytes().to_vec())
                    .or_insert_with(|| Node::Dir(BTreeMap::new()));
                dir = match node {
                    Node::Dir(map) => map,
                    Node::File(_) => panic!("file/dir clash in fixture"),
                };
            }
            dir.insert(
                segments[segments.len() - 1].as_bytes().to_vec(),
                Node::File(sha),
            );
        }
        self.write_dir(&root)
    }

    fn write_dir(&self, dir: &BTreeMap<Vec<u8>, Node>) -> String {
        let mut rows: Vec<(Vec<u8>, &str, Vec<u8>, String)> = Vec::new();
        for (name, node) in dir {
            match node {
                Node::File(sha) => rows.push((name.clone(), "100644", name.clone(), sha.clone())),
                Node::Dir(children) => {
                    let sha = self.write_dir(children);
                    let mut key = name.clone();
                    key.push(b'/');
                    rows.push((key, "40000", name.clone(), sha));
                }
            }
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let entries: Vec<(&str, &[u8], &str)> = rows
            .iter()
            .map(|(_, mode, name, sha)| (*mode, name.as_slice(), sha.as_str()))
            .collect();
        self.raw_tree(&entries)
    }

    pub fn raw_commit(&self, body: &[u8]) -> String {
        self.run_in(
            &self.root,
            &[
                "--git-dir",
                git_spelling(&self.repo)
                    .to_str()
                    .expect("UTF-8 fixture path"),
                "hash-object",
                "-t",
                "commit",
                "-w",
                "--stdin",
            ],
            Some(body),
        )
    }

    pub fn commit(&self, tree: &str, parents: &[&str]) -> String {
        let mut args = vec!["commit-tree", tree, "-m", "fixture"];
        for parent in parents {
            args.push("-p");
            args.push(parent);
        }
        self.git(&args)
    }

    pub fn set_ref(&self, name: &str, sha: &str) {
        self.git(&["update-ref", name, sha]);
    }

    /// Commit `files` on top of `parents` and move `refs/heads/main` there.
    pub fn commit_files(&self, files: &[(&str, &[u8])], parents: &[&str]) -> String {
        let tree = self.tree(files);
        let commit = self.commit(&tree, parents);
        self.set_ref("refs/heads/main", &commit);
        commit
    }
}

/// Remove a fixture tree. Windows cannot delete a file a process still holds
/// open, and a just-killed Git child or an idling shared model worker may
/// hold one for a moment after the test is done with it (Unix unlinks open
/// files): retry there for a bounded time instead of leaking the tree.
pub fn remove_tree(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) if cfg!(windows) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        remove_tree(&self.root);
        #[cfg(unix)]
        remove_short_runtime_dirs(&self.root);
    }
}

/// Remove the short shared-worker runtime dirs (`model_host::runtime_dir`)
/// of fixtures rooted at the temp entry `top`.
#[cfg(unix)]
pub fn remove_short_runtime_dirs(top: &std::path::Path) {
    let hash = top
        .as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
        });
    let prefix = format!("kbr-{hash:016x}-");
    if let Ok(entries) = std::fs::read_dir("/tmp") {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// The platform-native spelling a cache returns for `path`: its parent
/// canonicalized (Windows adds the `\\?\` verbatim prefix), the file name
/// kept (the file itself may not exist yet). Compare returned paths to this.
pub fn canonical_file(path: &std::path::Path) -> PathBuf {
    let parent = path.parent().expect("fixture file parent");
    parent
        .canonicalize()
        .expect("existing fixture directory")
        .join(path.file_name().expect("fixture file name"))
}

pub fn sha(hex: &str) -> Sha {
    Sha::parse(hex).expect("40-hex sha")
}

pub fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

/// The three required root files plus `extra`.
pub fn with_required<'a>(extra: &[(&'a str, &'a [u8])]) -> Vec<(&'a str, &'a [u8])> {
    let mut files = vec![
        ("index.md", INDEX),
        (".gitignore", GITIGNORE),
        (".assets/manifest.json", MANIFEST),
    ];
    for (path, content) in extra {
        files.retain(|(p, _)| p != path);
        files.push((path, content));
    }
    files
}

/// A reparse point at `link` leading to `target`'s location: a real file
/// symlink where the account may create one (SeCreateSymbolicLinkPrivilege:
/// elevated sessions such as hosted CI, or Developer Mode); on a default
/// Windows account, which may not, a directory junction to `target`'s parent
/// (no privilege needed), still a reparse point at the same path. Only the
/// real symlink can catch a regression that follows file symlinks.
#[cfg(windows)]
pub fn windows_file_reparse(target: &std::path::Path, link: &std::path::Path) {
    const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
    match std::os::windows::fs::symlink_file(target, link) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => {
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(git_spelling(link))
                .arg(git_spelling(target.parent().expect("target parent")))
                .output()
                .expect("junction fixture");
            assert!(output.status.success(), "junction fixture: {output:?}");
        }
        Err(error) => panic!("file symlink fixture: {error}"),
    }
}
