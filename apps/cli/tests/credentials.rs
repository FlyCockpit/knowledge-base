//! CLI credential boundary fixture tests.
#![allow(clippy::unwrap_used)] // Assertions and fixture setup.
#[cfg(windows)]
#[path = "../crates/kb-local/tests/support/child_guard.rs"]
mod child_guard;
#[cfg(windows)]
use child_guard::ChildGuard;

mod support;
use kb::state::CredentialStore;
use kb_client::{
    origin::{McpResource, TransportPolicy},
    types::SecretToken,
};
use std::fs;
use support::{Server, cli, empty_credential_store, remote};

fn resource(origin: &str) -> McpResource {
    McpResource::parse(origin, TransportPolicy::AllowLoopbackHttp).unwrap()
}
fn import(dir: &std::path::Path, origin: &str) {
    // Initial state is fixture I/O, outside the logout/network command's
    // watchdog. Native stdin/file import and private-parent creation have
    // dedicated primary-action tests; use login's actual save boundary here.
    CredentialStore::new(dir.join("data/credentials"))
        .save(
            &resource(origin),
            &SecretToken::new("disposable-pat-canary".into()),
        )
        .unwrap();
}

#[test]
fn fixture_credentials_are_private_origin_bound_state_without_config() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    assert!(!dir.path().join("data").exists());
    import(dir.path(), origin);
    let root = dir.path().join("data/credentials");
    kb::state::check_private_path(&root, true).unwrap();
    let store = CredentialStore::new(root);
    assert_eq!(
        store
            .load(&resource(origin))
            .unwrap()
            .unwrap()
            .expose_secret(),
        "disposable-pat-canary"
    );
    assert!(
        store
            .load(&resource("https://other.example"))
            .unwrap()
            .is_none()
    );
    assert!(!dir.path().join("config").exists());
}

#[test]
fn stdin_import_exact_token_cap_accepts_line_endings_and_rejects_every_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    let store = empty_credential_store(dir.path(), &resource(origin));
    let token = "a".repeat(8192);
    for ending in ["", "\n", "\r\n"] {
        cli(dir.path())
            .args(["login", "--server", origin, "--token-stdin"])
            .write_stdin(format!("{token}{ending}"))
            .assert()
            .success();
        assert_eq!(
            store
                .load(&resource(origin))
                .unwrap()
                .unwrap()
                .expose_secret(),
            token
        );
    }
    for suffix in ["a", "\nsecond-line", "\r\nsecond-line", "\n\n", "\r\n\n"] {
        let out = cli(dir.path())
            .args(["login", "--server", origin, "--token-stdin"])
            .write_stdin(format!("{token}{suffix}"))
            .assert()
            .failure()
            .get_output()
            .clone();
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains(&token));
        assert_eq!(
            CredentialStore::new(dir.path().join("data/credentials"))
                .load(&resource(origin))
                .unwrap()
                .unwrap()
                .expose_secret(),
            token
        );
    }
}

#[cfg(unix)]
#[test]
fn private_file_import_exact_token_cap_does_not_discard_suffix_or_change_old_state() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    let store = empty_credential_store(dir.path(), &resource(origin));
    let path = dir.path().join("token");
    fs::write(&path, "").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let token = "a".repeat(8192);
    for ending in ["", "\n", "\r\n"] {
        fs::write(&path, format!("{token}{ending}")).unwrap();
        cli(dir.path())
            .args([
                "login",
                "--server",
                origin,
                "--token-file",
                path.to_str().unwrap(),
            ])
            .assert()
            .success();
        assert_eq!(
            store
                .load(&resource(origin))
                .unwrap()
                .unwrap()
                .expose_secret(),
            token
        );
    }
    for suffix in ["a", "\nsecond-line", "\r\nsecond-line", "\n\n"] {
        fs::write(&path, format!("{token}{suffix}")).unwrap();
        cli(dir.path())
            .args([
                "login",
                "--server",
                origin,
                "--token-file",
                path.to_str().unwrap(),
            ])
            .assert()
            .failure();
        assert_eq!(
            CredentialStore::new(dir.path().join("data/credentials"))
                .load(&resource(origin))
                .unwrap()
                .unwrap()
                .expose_secret(),
            token
        );
    }
}

#[test]
fn logout_reclaims_private_orphans_with_and_without_a_published_credential() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    import(dir.path(), origin);
    let root = dir.path().join("data/credentials");
    for _ in 0..2 {
        // A synced temp persisted without publication models the SIGKILL
        // artifact produced by state::tests::interrupted_writer_child.
        let mut orphan = tempfile::NamedTempFile::new_in(&root).unwrap();
        #[cfg(windows)]
        {
            use std::io::Write;
            use std::process::Stdio;
            let mut helper = ChildGuard::new(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.FileSecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $p -AclObject $a"])
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap());
            helper
                .stdin
                .take()
                .unwrap()
                .write_all(orphan.path().to_str().unwrap().as_bytes())
                .unwrap();
            assert!(helper.wait().unwrap().success());
        }
        use std::io::Write;
        orphan.write_all(b"disposable-orphan").unwrap();
        orphan.as_file().sync_all().unwrap();
        let (_, orphan_path) = orphan.keep().unwrap();
        cli(dir.path())
            .args(["logout", "--server", origin, "--local"])
            .assert()
            .success();
        assert!(!orphan_path.exists());
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == ".lock")
        );
    }
}

#[cfg(unix)]
#[test]
fn orphan_cleanup_spares_unknown_files_and_refuses_symlinks_and_hardlinks() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let origin = resource("https://kb.example");
    let root = dir.path().join("credentials");
    let store = CredentialStore::new(root.clone());
    store
        .save(&origin, &SecretToken::new("disposable-old".into()))
        .unwrap();
    let unrelated = root.join(".tmp-user-file");
    fs::write(&unrelated, "user data").unwrap();
    assert!(store.load(&origin).unwrap().is_some());
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "user data");
    let mut orphan = tempfile::NamedTempFile::new_in(&root).unwrap();
    use std::io::Write;
    orphan.write_all(b"disposable-orphan").unwrap();
    let (_, target) = orphan.keep().unwrap();
    let alias = root.join(".tmpABC123");
    fs::hard_link(&target, &alias).unwrap();
    assert!(store.load(&origin).is_err());
    assert!(target.exists() && alias.exists());
    fs::remove_file(&alias).unwrap();
    symlink(&unrelated, &alias).unwrap();
    assert!(store.load(&origin).is_err());
    assert!(
        fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "user data");
    fs::remove_file(alias).unwrap();
    assert!(store.load(&origin).unwrap().is_some());
}

#[test]
fn default_logout_revokes_exact_pat_no_body_and_clears_only_its_origin() {
    let server = Server::new(|_, _, _| (204, String::new(), String::new()));
    let other = Server::new(|_, _, _| (204, String::new(), String::new()));
    let dir = tempfile::tempdir().unwrap();
    import(dir.path(), &server.origin);
    import(dir.path(), &other.origin);
    remote(dir.path(), "logout", &server.origin)
        .assert()
        .success();
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].wire.starts_with("POST /api/kb/token/revoke-self "));
    assert!(
        seen[0]
            .wire
            .contains("authorization: Bearer disposable-pat-canary\r\n")
    );
    assert_eq!(seen[0].wire.split("\r\n\r\n").nth(1).unwrap(), "");
    let store = CredentialStore::new(dir.path().join("data/credentials"));
    assert!(store.load(&resource(&server.origin)).unwrap().is_none());
    assert!(store.load(&resource(&other.origin)).unwrap().is_some());
    assert!(other.seen.lock().unwrap().is_empty());
}

#[test]
fn override_config_proxy_and_redirect_never_borrow_a_different_origin_token() {
    let target = Server::new(|_, _, _| (204, String::new(), String::new()));
    let location = target.origin.clone();
    let original = Server::new(move |_, _, _| {
        (
            307,
            format!("location: {location}/capture\r\n"),
            "{}".into(),
        )
    });
    let dir = tempfile::tempdir().unwrap();
    import(dir.path(), &original.origin);
    fs::create_dir_all(dir.path().join("config")).unwrap();
    fs::write(
        dir.path().join("config/config.toml"),
        format!(
            "server = {:?}\nproxy = {:?}\n",
            target.origin, target.origin
        ),
    )
    .unwrap();
    cli(dir.path())
        .args(["logout", "--allow-loopback-http"])
        .assert()
        .success();
    remote(dir.path(), "logout", &target.origin)
        .assert()
        .success();
    assert!(target.seen.lock().unwrap().is_empty());
    fs::write(dir.path().join("config/config.toml"), "").unwrap();
    cli(dir.path())
        .env("HTTP_PROXY", &target.origin)
        .env("ALL_PROXY", &target.origin)
        .env("NO_PROXY", "")
        .args([
            "logout",
            "--server",
            &original.origin,
            "--allow-loopback-http",
        ])
        .assert()
        .failure();
    assert_eq!(original.seen.lock().unwrap().len(), 1);
    assert!(target.seen.lock().unwrap().is_empty());
    // Login also sends no existing bearer, including through an explicit proxy.
    fs::write(
        dir.path().join("config/config.toml"),
        format!("proxy = {:?}\n", target.origin),
    )
    .unwrap();
    remote(dir.path(), "login", &original.origin)
        .assert()
        .failure();
    let seen = target.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(!seen[0].wire.to_lowercase().contains("authorization:"));
}

#[test]
fn offline_keeps_retryable_local_state_and_local_only_warns_without_network() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "http://127.0.0.1:1";
    import(dir.path(), origin);
    let out = remote(dir.path(), "logout", origin)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&out.stderr).contains("remote revocation is unknown"));
    let store = CredentialStore::new(dir.path().join("data/credentials"));
    assert!(store.load(&resource(origin)).unwrap().is_some());
    let server = Server::new(|_, _, _| (204, String::new(), String::new()));
    import(dir.path(), &server.origin);
    let out = remote(dir.path(), "logout", &server.origin)
        .args(["--local"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(String::from_utf8_lossy(&out.stderr).contains("remote token remains active"));
    assert!(server.seen.lock().unwrap().is_empty());
    assert!(store.load(&resource(&server.origin)).unwrap().is_none());
}

#[test]
fn canonical_state_binding_debug_redaction_and_corrupt_state_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(dir.path().join("credentials"));
    let a = resource("HTTPS://KB.EXAMPLE:443/");
    assert!(store.load(&a).unwrap().is_none());
    store
        .save(&a, &SecretToken::new("disposable-pat-canary".into()))
        .unwrap();
    let token = store
        .load(&resource("https://kb.example/mcp"))
        .unwrap()
        .unwrap();
    assert!(!format!("{token:?}").contains("disposable-pat-canary"));
    assert!(
        store
            .load(&resource("https://other.example"))
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .load(&resource("https://kb.example:8443"))
            .unwrap()
            .is_none()
    );
    let file = fs::read_dir(dir.path().join("credentials"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|s| s == "json"))
        .unwrap();
    #[cfg(unix)]
    {
        let text = fs::read_to_string(&file).unwrap();
        fs::write(
            &file,
            text.replace("https://kb.example/mcp", "https://evil.example/mcp"),
        )
        .unwrap();
        assert!(store.load(&a).is_err());
    }
    #[cfg(windows)]
    {
        assert!(
            !fs::read(&file)
                .unwrap()
                .windows(21)
                .any(|s| s == b"disposable-pat-canary")
        );
        fs::write(&file, b"plaintext-fallback-forbidden").unwrap();
        assert!(store.load(&a).is_err());
    }
}

#[test]
fn import_never_uses_argv_or_config_and_redacts_invalid_input() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    let store = empty_credential_store(dir.path(), &resource(origin));
    let out = cli(dir.path())
        .args(["login", "--server", origin, "--token-stdin"])
        .write_stdin("disposable-pat-canary\n")
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(!String::from_utf8_lossy(&out.stdout).contains("disposable-pat-canary"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("disposable-pat-canary"));
    assert!(!dir.path().join("config/config.toml").exists());
    assert_eq!(
        store
            .load(&resource(origin))
            .unwrap()
            .unwrap()
            .expose_secret(),
        "disposable-pat-canary"
    );
    let out = cli(dir.path())
        .args(["login", "--server", origin, "--token-stdin"])
        .write_stdin("disposable-pat-canary\nsecond-line")
        .assert()
        .failure()
        .get_output()
        .clone();
    assert!(!String::from_utf8_lossy(&out.stderr).contains("disposable-pat-canary"));
    // No token argument exists; do not pass a secret to a usage-error printer.
    cli(dir.path()).args(["login", "--help"]).assert().success();
    cli(dir.path()).args(["config", "show"]).assert().success();
}

#[cfg(unix)]
#[test]
fn private_modes_symlink_parent_file_import_and_loose_permissions_are_rejected() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let dir = tempfile::tempdir().unwrap();
    let origin = "https://kb.example";
    import(dir.path(), origin);
    let parent = dir.path().join("data/credentials");
    assert_eq!(
        fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let file = fs::read_dir(&parent)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|s| s == "json"))
        .unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let store = CredentialStore::new(parent.clone());
    assert!(store.load(&resource(origin)).is_err());
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let intermediate = dir.path().join("linked-data");
    symlink(dir.path().join("data"), &intermediate).unwrap();
    assert!(
        CredentialStore::new(intermediate.join("credentials"))
            .load(&resource(origin))
            .is_err()
    );
    fs::remove_file(&file).unwrap();
    let target = dir.path().join("target");
    fs::write(&target, "disposable-pat-canary").unwrap();
    symlink(&target, &file).unwrap();
    assert!(store.load(&resource(origin)).is_err());
    assert!(
        store
            .save(&resource(origin), &SecretToken::new("replacement".into()))
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "disposable-pat-canary"
    );
    let link = dir.path().join("link");
    symlink(&parent, &link).unwrap();
    assert!(CredentialStore::new(link).load(&resource(origin)).is_err());
    cli(dir.path())
        .args([
            "login",
            "--server",
            origin,
            "--token-file",
            target.to_str().unwrap(),
        ])
        .assert()
        .failure();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    let hard = dir.path().join("hard-token");
    fs::hard_link(&target, &hard).unwrap();
    cli(dir.path())
        .args([
            "login",
            "--server",
            "https://third.example",
            "--token-file",
            hard.to_str().unwrap(),
        ])
        .assert()
        .failure();
    fs::remove_file(&hard).unwrap();
    let unsafe_parent = dir.path().join("writable-parent");
    fs::create_dir(&unsafe_parent).unwrap();
    fs::set_permissions(&unsafe_parent, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        CredentialStore::new(unsafe_parent.join("credentials"))
            .save(
                &resource("https://third.example"),
                &SecretToken::new("disposable".into())
            )
            .is_err()
    );
    let import_link = dir.path().join("import-link");
    symlink(&target, &import_link).unwrap();
    cli(dir.path())
        .args([
            "login",
            "--server",
            "https://second.example",
            "--token-file",
            import_link.to_str().unwrap(),
        ])
        .assert()
        .failure();
    cli(dir.path())
        .args([
            "login",
            "--server",
            "https://second.example",
            "--token-file",
            target.to_str().unwrap(),
        ])
        .assert()
        .success();
}

#[test]
fn removing_an_old_credential_cannot_delete_a_concurrent_relogin() {
    enum Event {
        Started,
        Finished(std::io::Result<std::process::Output>),
    }
    enum Flow {
        Empty,
        Relogin,
        Cancel,
    }
    for flow in [Flow::Empty, Flow::Relogin, Flow::Cancel] {
        let empty = matches!(flow, Flow::Empty);
        let cancel = matches!(flow, Flow::Cancel);
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let started_tx = event_tx.clone();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let server = Server::new(move |_, _, _| {
            // Rendezvous only on the old-token request. Disk publication must
            // happen after the HTTP response, under the real credential lock:
            // the product's ten-second HTTP budget is independent of fsync.
            // Disconnect also releases the server when a parent assertion fails.
            if started_tx.send(Event::Started).is_err() || finish_rx.recv().is_err() {
                return (503, String::new(), String::new());
            }
            (204, String::new(), String::new())
        });
        let dir = tempfile::tempdir().unwrap();
        if !empty {
            import(dir.path(), &server.origin);
        }
        let credentials = dir.path().join("data/credentials");
        let replacement = if !empty && !cancel {
            let prepared = dir.path().join("prepared-credentials");
            CredentialStore::new(prepared.clone())
                .save(
                    &resource(&server.origin),
                    &SecretToken::new("disposable-new".into()),
                )
                .unwrap();
            Some(
                fs::read_dir(prepared)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| {
                        path.extension()
                            .is_some_and(|extension| extension == "json")
                    })
                    .unwrap(),
            )
        } else {
            None
        };
        // Open before the request; taking this uncontended kernel lock after
        // request entry involves no private-file writes or directory fsync.
        let publication_lock = replacement.as_ref().map(|_| {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(credentials.join(".lock"))
                .unwrap()
        });
        let output = std::thread::scope(|scope| {
            // Drop the permit before scoped joining if publication panics.
            let publication_permit = publication_lock;
            // Drop this sender before scoped joining on unwind, so a failed login
            // cannot strand the server or the pending logout child.
            let release = finish_tx;
            scope.spawn(|| {
                let result = remote(dir.path(), "logout", &server.origin).output();
                let _ = event_tx.send(Event::Finished(result));
            });
            match event_rx.recv().unwrap() {
                Event::Started if !empty => {}
                Event::Started => panic!("empty logout attempted remote revocation"),
                Event::Finished(result) if empty => return result.unwrap(),
                Event::Finished(result) => {
                    panic!("logout exited before the revocation boundary: {result:?}")
                }
            }
            if cancel {
                // Model parent failure while the actual HTTP request is pending.
                drop(release);
            } else {
                let publication_lock = publication_permit.as_ref().unwrap();
                publication_lock.lock().unwrap();
                release.send(()).unwrap();
                // The synced, private, origin-bound replacement uses save's
                // atomic rename publication. Logout has its successful response
                // and must wait on the same lock before comparing/removing.
                // Primary save/durability tests remain separate from this race.
                let replacement = replacement.as_ref().unwrap();
                fs::rename(
                    replacement,
                    credentials.join(replacement.file_name().unwrap()),
                )
                .unwrap();
                publication_lock.unlock().unwrap();
            }
            match event_rx.recv().unwrap() {
                Event::Finished(result) => result.unwrap(),
                Event::Started => panic!("unexpected second revocation request"),
            }
        });
        if empty {
            assert!(output.status.success(), "{output:?}");
            assert!(String::from_utf8_lossy(&output.stdout).contains("no local credential"));
            assert!(server.seen.lock().unwrap().is_empty());
            assert!(
                CredentialStore::new(dir.path().join("data/credentials"))
                    .load(&resource(&server.origin))
                    .unwrap()
                    .is_none()
            );
            continue;
        }
        if cancel {
            assert!(!output.status.success(), "cancelled revocation must fail");
            assert!(String::from_utf8_lossy(&output.stderr).contains("HTTP 503"));
        } else {
            assert!(output.status.success(), "{output:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("current local credential retained")
            );
        }
        let store = CredentialStore::new(dir.path().join("data/credentials"));
        assert_eq!(
            store
                .load(&resource(&server.origin))
                .unwrap()
                .unwrap()
                .expose_secret(),
            if cancel {
                "disposable-pat-canary"
            } else {
                "disposable-new"
            }
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_acl_is_current_user_only_and_broad_import_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    import(dir.path(), "https://kb.example");
    let parent = dir.path().join("data/credentials");
    // The same validation used for imports must reject inherited/broad ACLs,
    // and accept the DACL set by the store on both the directory and files.
    kb::state::check_private_path(&parent, true).unwrap();
    for e in fs::read_dir(&parent).unwrap() {
        kb::state::check_private_path(&e.unwrap().path(), false).unwrap();
    }
    let broad = dir.path().join("broad-token");
    fs::write(&broad, "disposable-import-canary").unwrap();
    cli(dir.path())
        .args([
            "login",
            "--server",
            "https://other.example",
            "--token-file",
            broad.to_str().unwrap(),
        ])
        .assert()
        .failure();
}

#[test]
fn malformed_config_and_credential_urls_never_echo_their_canaries() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("config")).unwrap();
    for text in [
        "server = \"disposable-config-canary",
        "root = [\"disposable-config-canary\"]",
        "root = \"https://user:disposable-config-canary@kb.example\"",
        "models_dir = \"disposable-config-canary\"",
        "loopback_http_opt_in = \"http://user:disposable-config-canary@localhost\"",
        "\"disposable-config-canary\" = 1",
        "server = \"https://user:disposable-config-canary@kb.example\"",
        "proxy = \"http://user:disposable-config-canary@kb.example\"",
    ] {
        fs::write(dir.path().join("config/config.toml"), text).unwrap();
        let out = cli(dir.path())
            .args(["config", "show"])
            .assert()
            .failure()
            .get_output()
            .clone();
        assert!(!String::from_utf8_lossy(&out.stderr).contains("disposable-config-canary"));
        assert!(out.stdout.is_empty());
    }
}
