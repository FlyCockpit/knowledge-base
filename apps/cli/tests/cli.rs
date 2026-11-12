//! Black-box integration tests: run the built binary and assert on its
//! behavior (stdout, stderr, exit code). This is the highest-value test layer
//! for a CLI — it exercises argument parsing, dispatch, and output formatting
//! exactly as a user would.
//!
//! Tests use a throwaway config dir via `KB_CONFIG_DIR` so they never touch
//! the developer's real config.

use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::Value;

#[test]
fn cargo_deny_checks_every_release_target_and_feature() {
    use std::collections::BTreeSet;

    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Graph {
        targets: Vec<String>,
        #[serde(rename = "all-features")]
        all_features: bool,
    }

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let policy: toml::Value =
        toml::from_str(&std::fs::read_to_string(root.join("deny.toml")).unwrap()).unwrap();
    // Only targets/all-features are permitted: exclusions or disabled defaults
    // must not silently remove a shipped dependency from the checked graph.
    let graph: Graph = policy["graph"].clone().try_into().unwrap();
    assert!(graph.all_features, "check every release feature");
    let checked: BTreeSet<_> = graph.targets.iter().map(String::as_str).collect();
    assert!(!checked.is_empty(), "the release graph must not be empty");
    assert_eq!(checked.len(), graph.targets.len(), "no duplicate targets");

    let distribution: toml::Value =
        toml::from_str(&std::fs::read_to_string(root.join("dist-workspace.toml")).unwrap())
            .unwrap();
    let shipped: BTreeSet<_> = distribution["dist"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target.as_str().unwrap())
        .collect();
    assert_eq!(checked, shipped, "check exactly every shipped target");
}

#[test]
fn model_list_is_bounded_machine_readable_and_optional_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    let mut cmd = cli(tmp.path());
    cmd.args(["model", "--root"])
        .arg(&store)
        .args(["--json", "list"]);
    let value = json_stdout(cmd);
    assert_eq!(value.as_array().unwrap().len(), 8);
    assert!(
        value
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["estimatedBytes"].as_u64().unwrap() > 0)
    );
    let s = kb_local::Store::open(&store).unwrap();
    assert!(!s.model_state().unwrap().enabled);
    assert_eq!(s.model_state().unwrap().context_tokens, 1024);
    let mut cmd = cli(tmp.path());
    cmd.args(["model", "--root"])
        .arg(&store)
        .args(["--json", "disable"]);
    assert_eq!(json_stdout(cmd)["enabled"], false);
}

/// R3-L7: a worker that cannot start here is reported, not "starts on demand".
#[cfg(unix)]
#[test]
fn model_status_reports_why_the_worker_cannot_start() {
    let tmp = tempfile::tempdir().unwrap();
    // A cache path too long for a Unix socket, and no XDG_RUNTIME_DIR.
    let cache = tmp.path().join("c".repeat(120));
    std::fs::create_dir_all(&cache).unwrap();
    let mut cmd = cli(tmp.path());
    cmd.env("HOME", tmp.path())
        .env("XDG_CACHE_HOME", &cache)
        .env_remove("XDG_RUNTIME_DIR")
        .args(["model", "--json", "status"]);
    let value = json_stdout(cmd);
    assert!(value["worker"].is_null());
    assert!(
        value["workerError"]
            .as_str()
            .is_some_and(|why| why.contains("too long for a Unix socket")),
        "{value}"
    );
    let mut cmd = cli(tmp.path());
    cmd.env("HOME", tmp.path())
        .env("XDG_CACHE_HOME", &cache)
        .env_remove("XDG_RUNTIME_DIR")
        .args(["model", "status"]);
    cmd.assert()
        .success()
        .stdout(predicate::str::contains("embedding worker: cannot start:"));
}

/// R3-L9 (review #2): `kb model remove` needs confirmation (`--yes` without
/// a terminal) and is never refused because a store has the model enabled:
/// that store searches by keyword until the model is downloaded again.
#[cfg(unix)]
#[test]
fn model_remove_confirms_and_is_not_blocked_by_an_enabled_store() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = tmp.path().join("cache");
    let runtime = tmp.path().join("rt");
    for dir in [&tmp.path().to_path_buf(), &cache, &runtime] {
        std::fs::create_dir_all(dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let store = tmp.path().join("store");
    let s = kb_local::Store::open(&store).unwrap();
    let model = s.model_state().unwrap().model_id;
    rusqlite::Connection::open(s.paths().state_db())
        .unwrap()
        .execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
        .unwrap();
    drop(s);
    let remove = |yes: bool| {
        let mut cmd = cli(tmp.path());
        cmd.env("HOME", tmp.path())
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_RUNTIME_DIR", &runtime)
            .args(["model", "--root"])
            .arg(&store)
            .args(["remove", &model]);
        if yes {
            cmd.arg("--yes");
        }
        cmd
    };
    remove(false)
        .assert()
        .failure()
        .stderr(predicate::str::contains("--yes"));
    remove(true)
        .assert()
        .success()
        .stdout(predicate::str::contains("was not downloaded"));
}

/// Build a `Command` for the binary with an isolated, empty config dir.
fn cli(config_dir: &std::path::Path) -> Command {
    let mut cmd = Command::cargo_bin("kb").expect("binary builds");
    cmd.env("KB_CONFIG_DIR", config_dir)
        .env("HOME", config_dir)
        .env("XDG_CONFIG_HOME", config_dir.join("cfg"))
        .env("XDG_DATA_HOME", config_dir.join("data"))
        .env("XDG_CACHE_HOME", config_dir.join("cache"))
        .env("XDG_RUNTIME_DIR", config_dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/nobus", config_dir.display()),
        );
    // Log-filter env vars from the developer's shell would override the flags
    // under test.
    cmd.env_remove("KB_LOG");
    cmd.env_remove("RUST_LOG");
    cmd
}

fn json_stdout(mut cmd: Command) -> Value {
    let stdout = cmd.assert().success().get_output().stdout.clone();
    serde_json::from_slice(&stdout).expect("stdout is valid JSON")
}

#[test]
fn config_path_json_is_machine_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = cli(tmp.path());
    cmd.args(["config", "--json", "path"]);
    let value = json_stdout(cmd);

    assert!(value["path"].as_str().is_some_and(|path| !path.is_empty()));
}

#[test]
fn config_show_json_is_machine_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cmd = cli(tmp.path());
    cmd.args(["config", "--json", "show"]);
    let value = json_stdout(cmd);

    assert!(value.is_object());
}

#[test]
fn config_init_json_reports_whether_it_created_the_file() {
    let tmp = tempfile::tempdir().unwrap();
    let mut first = cli(tmp.path());
    first.args(["config", "--json", "init"]);
    let first_value = json_stdout(first);

    let mut second = cli(tmp.path());
    second.args(["config", "--json", "init"]);
    let second_value = json_stdout(second);

    assert_eq!(first_value["created"], true);
    assert_eq!(second_value["created"], false);
    assert_eq!(first_value["path"], second_value["path"]);
}

#[test]
fn config_init_then_show() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path()).args(["config", "init"]).assert().success();
    cli(tmp.path()).args(["config", "show"]).assert().success();
}

#[test]
fn config_concurrent_setters_read_after_the_mutation_lock() {
    use std::{fs::OpenOptions, sync::mpsc, time::Duration};
    let tmp = tempfile::tempdir().expect("config directory");
    cli(tmp.path()).args(["config", "init"]).assert().success();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(tmp.path().join(".config.lock"))
        .expect("stable config lock");
    lock.lock().expect("hold setters before their read");
    let root = tmp.path().join("store");
    let models = tmp.path().join("models");
    std::thread::scope(|scope| {
        let (started, starts) = mpsc::channel();
        let (done, completions) = mpsc::channel();
        let mut workers = Vec::new();
        for (setter, value) in [
            ("set-root", root.as_os_str()),
            ("set-models-dir", models.as_os_str()),
            ("set-server", std::ffi::OsStr::new("https://kb.example")),
        ] {
            let started = started.clone();
            let done = done.clone();
            let dir = tmp.path();
            workers.push(scope.spawn(move || {
                let mut command = cli(dir);
                command.args(["config", setter]).arg(value);
                started.send(()).expect("started");
                let result = command.output().expect("setter");
                done.send(()).expect("completed");
                result
            }));
        }
        for _ in 0..3 {
            starts
                .recv_timeout(Duration::from_secs(5))
                .expect("writer started");
        }
        assert!(
            matches!(
                completions.recv_timeout(Duration::from_millis(250)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "setters must wait for the config lock"
        );
        lock.unlock().expect("release setters");
        for worker in workers {
            let result = worker.join().expect("setter thread");
            assert!(result.status.success(), "{:?}", result.stderr);
        }
    });
    let mut command = cli(tmp.path());
    command.args(["config", "--json", "show"]);
    let config = json_stdout(command);
    assert_eq!(config["root"], root.to_str().expect("root"));
    assert_eq!(config["models_dir"], models.to_str().expect("models"));
    assert_eq!(config["server"], "https://kb.example");
}

#[test]
fn completions_generates_shell_script() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("_kb"));
}

#[test]
fn unknown_command_is_a_usage_error() {
    let tmp = tempfile::tempdir().unwrap();
    // clap exits 2 for usage errors.
    cli(tmp.path())
        .arg("definitely-not-a-command")
        .assert()
        .code(2);
}

#[test]
fn version_prints_package_version() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn help_lists_commands() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("Commands:"))
        .stdout(predicate::str::contains("config"))
        .stdout(predicate::str::contains("completions"))
        .stdout(predicate::str::contains("kb"));
}

#[test]
fn package_is_kb_under_apache_license() {
    assert_eq!(env!("CARGO_PKG_NAME"), "kb");
    assert_eq!(env!("CARGO_PKG_LICENSE"), "Apache-2.0");
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains("kb"));
}

#[test]
fn global_log_flags_do_not_pollute_stdout() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["--verbose", "--log-format", "json", "config", "path"])
        .assert()
        .success()
        .stdout(predicate::str::contains("config.toml"))
        .stderr(predicate::str::contains(r#""level":"DEBUG""#))
        .stderr(predicate::str::contains("resolved config path"));
}

#[test]
fn quiet_conflicts_with_verbose() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["--quiet", "--verbose", "config", "path"])
        .assert()
        .code(2);
}

#[test]
fn config_path_text_prints_path() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["config", "path"])
        .assert()
        .success()
        .stdout(predicate::str::contains("config.toml"));
}

#[test]
fn provider_owner_cli_empty_list_and_no_secret_argv() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    let mut cmd = cli(tmp.path());
    cmd.args([
        "providers",
        "--root",
        root.to_str().unwrap(),
        "--json",
        "list",
    ]);
    assert_eq!(json_stdout(cmd), serde_json::json!([]));
    cli(tmp.path())
        .args([
            "providers",
            "register",
            "--api-key",
            "disposable-argv-canary",
        ])
        .assert()
        .code(2);
    cli(tmp.path())
        .args(["providers", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("loopback"));
}

#[cfg(target_os = "linux")]
#[test]
fn provider_native_store_unavailable_is_explicit_and_never_saves_key() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    cli(tmp.path())
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", tmp.path().join("absent-bus").display()),
        )
        .args([
            "providers",
            "--root",
            root.to_str().unwrap(),
            "register",
            "--idempotency-key",
            "fixture-register-01",
            "--name",
            "fixture",
            "--endpoint",
            "https://provider.test/embeddings",
            "--model",
            "fixture-model",
            "--dimensions",
            "2",
            "--key-stdin",
        ])
        .write_stdin("disposable-provider-fixture-canary")
        .assert()
        .code(1)
        .stderr(predicate::str::contains("OS credential store unavailable"))
        .stderr(predicate::str::contains("disposable-provider-fixture-canary").not());
    for file in std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .filter(|f| f.path().is_file())
    {
        assert!(
            !std::fs::read(file.path())
                .unwrap()
                .windows(b"disposable-provider-fixture-canary".len())
                .any(|bytes| bytes == b"disposable-provider-fixture-canary")
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn unavailable_native_store_still_fences_revoke_before_cleanup_error() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    let store = kb_local::Store::open(&root).unwrap();
    // Setup is not the operation under test. Seed the same registered metadata
    // without spending a native credential deadline on fixture filesystem IO.
    let provider = kb_client::types::KbId::parse(&"p".repeat(24)).unwrap();
    let db = rusqlite::Connection::open(store.paths().state_db()).unwrap();
    db.execute(
        "INSERT INTO providers(id,name) VALUES(?1,'fixture')",
        [provider.as_str()],
    )
    .unwrap();
    db.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,1,'https://provider.test/embeddings','fixture',2,?2,'REGISTERED')", (provider.as_str(), format!("sha256:{}", "a".repeat(64)))).unwrap();
    db.execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES(?1,'fixture-register-01',zeroblob(32),?2,1)", (store.owner().id(), provider.as_str())).unwrap();
    let revision = store
        .provider_revision(&store.owner(), &provider, 1)
        .unwrap();
    assert_eq!(revision.state, "REGISTERED");
    cli(tmp.path())
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", tmp.path().join("absent-bus").display()),
        )
        .args([
            "providers",
            "--root",
            root.to_str().unwrap(),
            "revoke",
            "--provider",
            revision.provider_id.as_str(),
        ])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("OS credential store unavailable"));
    assert_eq!(
        store
            .provider_revision(&store.owner(), &revision.provider_id, 1)
            .unwrap()
            .state,
        "REVOKED"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn provider_input_policy_accepts_contract_keys_and_rejects_overflow_controls_and_suffixes() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("key");
    let receipts = |root: &std::path::Path| {
        let db = rusqlite::Connection::open_with_flags(
            root.join("state.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        db.query_row("SELECT count(*) FROM provider_registrations", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
    };
    for input in [
        "synthetic:fixture".to_owned(),
        "a".repeat(8193),
        "a".repeat(16384),
        format!("{}\r\n", "a".repeat(16384)),
        "a".repeat(16385),
        "control\tbyte".into(),
        "control\0byte".into(),
        "value\r".into(),
        "value\nsecond".into(),
        format!("{}\n\n", "a".repeat(16384)),
    ] {
        let valid = input == "synthetic:fixture"
            || input == "a".repeat(8193)
            || input == "a".repeat(16384)
            || input == format!("{}\r\n", "a".repeat(16384));
        for from_file in [false, true] {
            let root = tmp
                .path()
                .join(format!("store-{}-{}", input.len(), from_file));
            drop(kb_local::Store::open(&root).unwrap());
            let before = receipts(&root);
            let mut cmd = cli(tmp.path());
            cmd.env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", tmp.path().join("absent-bus").display()),
            )
            .args([
                "providers",
                "--root",
                root.to_str().unwrap(),
                "register",
                "--idempotency-key",
                "fixture-policy-01",
                "--name",
                "fixture",
                "--endpoint",
                "https://provider.test/embeddings",
                "--model",
                "fixture",
                "--dimensions",
                "2",
            ]);
            if from_file {
                std::fs::write(&file, &input).unwrap();
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
                cmd.args(["--key-file", file.to_str().unwrap()]);
            } else {
                cmd.arg("--key-stdin").write_stdin(input.clone());
            }
            let output = cmd.output().unwrap();
            assert!(!output.status.success());
            let err = String::from_utf8(output.stderr).unwrap();
            // Receipt creation is the acceptance boundary, independent of a
            // later unavailable/timed-out credential service. Invalid input
            // must still produce its exact error and no registration effect.
            assert_eq!(receipts(&root), before + i64::from(valid), "{err}");
            if valid {
                assert!(
                    err.contains("OS credential store unavailable")
                        || err.contains("local operation deadline exceeded"),
                    "{err}"
                );
            } else {
                assert!(err.contains("invalid token input"), "{err}");
            }
            assert!(!err.contains("synthetic:fixture"));
        }
    }
}

/// R3-L12: `kb config` repairs invalid settings one at a time, even while
/// another setting is still invalid; `show` names the repair command.
#[test]
fn config_set_commands_repair_invalid_settings() {
    let tmp = tempfile::tempdir().expect("temp dir");
    std::fs::write(
        tmp.path().join("config.toml"),
        "root = \"relative/store\"\nmodels_dir = \"models\"\n",
    )
    .expect("config");
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("kb config set-root"));
    let store = tmp.path().join("store");
    cli(tmp.path())
        .args(["config", "set-root"])
        .arg(&store)
        .assert()
        .success();
    // The other bad setting still reports, with its own repair command.
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("kb config set-models-dir"));
    cli(tmp.path())
        .args(["config", "set-models-dir"])
        .arg(tmp.path().join("models"))
        .assert()
        .success();
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .success()
        .stdout(predicate::str::contains("store"));
}

#[test]
fn config_setter_json_omits_invalid_urls_without_changing_them_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("config.toml");
    let canary = "disposable-invalid-url-canary";
    let invalid = format!("https://fixture:{canary}@kb.example");
    for setter in ["set-root", "set-models-dir", "set-server"] {
        for invalid_key in ["server", "proxy", "loopback_http_opt_in"] {
            let mut config = kb::config::Config {
                server: Some("https://kb.example".into()),
                proxy: Some("http://proxy.example:3128".into()),
                loopback_http_opt_in: Some("http://localhost:3100".into()),
                ..Default::default()
            };
            match invalid_key {
                "server" => config.server = Some(invalid.clone()),
                "proxy" => config.proxy = Some(invalid.clone()),
                _ => config.loopback_http_opt_in = Some(invalid.clone()),
            }
            std::fs::write(&path, toml::to_string(&config).unwrap()).unwrap();
            let mut cmd = cli(tmp.path());
            cmd.args(["config", "--json", setter]);
            if setter == "set-server" {
                cmd.arg("https://repaired.example");
            } else {
                cmd.arg(tmp.path().join("destination"));
            }
            let output = cmd.assert().success().get_output().clone();
            assert!(!String::from_utf8_lossy(&output.stdout).contains(canary));
            assert!(!String::from_utf8_lossy(&output.stderr).contains(canary));
            let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
            let saved: kb::config::Config =
                toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let saved_json = serde_json::to_value(&saved).unwrap();
            for key in ["server", "proxy", "loopback_http_opt_in"] {
                if saved_json[key] == invalid {
                    assert!(reply.get(key).is_none(), "omit invalid {key}");
                } else {
                    assert_eq!(reply.get(key), saved_json.get(key), "keep valid {key}");
                }
            }
            if setter != "set-server" || invalid_key == "proxy" {
                assert_eq!(saved_json[invalid_key], invalid);
            }
        }
    }
}

#[test]
fn config_parse_errors_identify_the_file_and_location_and_reject_unknown_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("config.toml");
    std::fs::write(&path, "root = [\n").unwrap();
    for args in [
        vec!["config", "show"],
        vec!["config", "set-root", "/tmp/store"],
    ] {
        cli(tmp.path())
            .args(args)
            .assert()
            .failure()
            .stderr(predicate::str::contains(path.display().to_string()))
            .stderr(predicate::str::contains("line"))
            .stderr(predicate::str::contains("column"));
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "root = [\n",
        "a setter must not discard a damaged config"
    );
    std::fs::write(&path, "modelsdir = '/tmp/models'\n").unwrap();
    cli(tmp.path())
        .args(["config", "show"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unknown config setting"));
}

#[test]
fn principal_id_errors_are_actionable_and_missing_removal_exits_not_found() {
    let tmp = tempfile::tempdir().unwrap();
    cli(tmp.path())
        .args(["principals", "create", "--kb", "bogus", "--access", "read"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains(
            "`bogus` is not a knowledge base ID",
        ));
    let root = tmp.path().join("store");
    drop(kb_local::Store::open(&root).unwrap());
    cli(tmp.path())
        .args(["principals", "--root"])
        .arg(&root)
        .args(["remove", "11111111-1111-4111-8111-111111111111"])
        .assert()
        .code(3)
        .stderr(predicate::str::contains("no principal"));
    let blocked = tmp.path().join("file");
    std::fs::write(&blocked, "regular file").unwrap();
    let root = blocked.join("store");
    cli(tmp.path())
        .args(["mcp", "--root"])
        .arg(&root)
        .assert()
        .failure()
        .stderr(predicate::str::contains(root.display().to_string()))
        .stderr(predicate::str::contains("opening or creating store"));
}
