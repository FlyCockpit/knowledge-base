//! CLI credential boundary fixture tests.
#![allow(clippy::unwrap_used)] // Assertions and fixture setup.
mod support;
use kb_client::origin::{McpResource, TransportPolicy};
use serde_json::Value;
use std::time::Duration;
use support::{Server, cli, empty_credential_store, remote};

#[test]
fn snake_case_pending_then_success_and_exact_orpc_envelope() {
    let server = Server::new(|i, _, origin| {
        (
            if i == 1 { 400 } else { 200 },
            String::new(),
            match i {
                0 => start(origin, 1, 600),
                1 => flow("authorization_pending"),
                _ => success(origin),
            },
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let resource = McpResource::parse(&server.origin, TransportPolicy::AllowLoopbackHttp).unwrap();
    let store = empty_credential_store(dir.path(), &resource);
    let out = remote(dir.path(), "login", &server.origin)
        .args(["--name", "Laptop"])
        .assert()
        .success()
        .get_output()
        .clone();
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert!(seen[0].wire.starts_with("POST /api/auth/device/code "));
    let body: Value = serde_json::from_str(seen[0].wire.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"client_id":"kb-cli", "scope":"mcp:read mcp:write"})
    );
    for r in &seen[1..] {
        assert!(
            r.wire
                .starts_with("POST /rpc/cliCredentials/exchangeDeviceCode ")
        );
        assert_eq!(
            serde_json::from_str::<Value>(r.wire.split("\r\n\r\n").nth(1).unwrap()).unwrap(),
            serde_json::json!({"json":{"deviceCode":"disposable-device-canary", "name":"Laptop"}})
        );
        assert!(!r.wire.to_lowercase().contains("authorization:"));
    }
    assert!(seen[2].at.duration_since(seen[1].at) >= Duration::from_millis(950));
    assert_eq!(
        store.load(&resource).unwrap().unwrap().expose_secret(),
        "disposable-pat-canary"
    );
    for canary in [
        "disposable-pat-canary",
        "disposable-device-canary",
        "disposable-server-message-canary",
    ] {
        assert!(!String::from_utf8_lossy(&out.stdout).contains(canary));
        assert!(!String::from_utf8_lossy(&out.stderr).contains(canary));
    }
    cli(dir.path()).args(["config", "show"]).assert().success();
}

#[test]
fn slow_down_from_http_stops_when_next_poll_would_reach_expiry() {
    let server = Server::new(|i, _, origin| {
        (
            if i == 1 { 400 } else { 200 },
            String::new(),
            match i {
                // After the first poll, the six-second slowed interval cannot
                // fit before expiry. Exact intervals and successful repeated
                // slow-downs use virtual time at the production poll boundary.
                0 => start(origin, 1, 7),
                1 => flow("slow_down"),
                _ => success(origin),
            },
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let out = remote(dir.path(), "login", &server.origin)
        .assert()
        .code(1)
        .get_output()
        .clone();
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert!(
        seen[1]
            .wire
            .starts_with("POST /rpc/cliCredentials/exchangeDeviceCode ")
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("device authorization expired"));
    assert!(!dir.path().join("data/credentials").exists());
}

#[test]
fn first_poll_authorization_persists_the_default_credential() {
    let server = Server::new(|i, _, origin| {
        (
            200,
            String::new(),
            if i == 0 {
                // Success-path wire/persistence fixture: expiry is asserted
                // separately at the paused-clock production polling boundary.
                start(origin, 1, 600)
            } else {
                success(origin)
            },
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let resource = McpResource::parse(&server.origin, TransportPolicy::AllowLoopbackHttp).unwrap();
    let store = empty_credential_store(dir.path(), &resource);
    let out = remote(dir.path(), "login", &server.origin)
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(out.status.success(), "{out:?}");
    assert_eq!(server.seen.lock().unwrap().len(), 2);
    assert_eq!(
        store.load(&resource).unwrap().unwrap().expose_secret(),
        "disposable-pat-canary"
    );
    assert!(!String::from_utf8_lossy(&out.stdout).contains("disposable-pat-canary"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("disposable-pat-canary"));
    cli(dir.path()).args(["config", "show"]).assert().success();
}

#[test]
fn denied_expired_consumed_and_untagged_errors_stop_without_saving_or_echoing() {
    for tag in ["access_denied", "expired_token", "invalid_grant", "unknown"] {
        let tag = tag.to_owned();
        let server = Server::new(move |i, _, origin| {
            (
                if i == 0 { 200 } else { 400 },
                String::new(),
                if i == 0 {
                    start(origin, 1, 30)
                } else {
                    flow(&tag)
                },
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let out = remote(dir.path(), "login", &server.origin)
            .assert()
            .failure()
            .get_output()
            .clone();
        assert_eq!(server.seen.lock().unwrap().len(), 2);
        assert!(!dir.path().join("data/credentials").exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("disposable-server-message-canary"));
    }
}

#[test]
fn rejects_foreign_resource_plain_success_redirect_and_wrong_status_tag() {
    let target = Server::new(|_, _, _| (200, String::new(), "{}".into()));
    for kind in 0..4 {
        let foreign = target.origin.clone();
        let server = Server::new(move |i, _, origin| {
            if i == 0 {
                return (200, String::new(), start(origin, 1, 30));
            }
            match kind {
                0 => (200, String::new(), success(&foreign)),
                1 => (
                    200,
                    String::new(),
                    serde_json::from_str::<Value>(&success(origin)).unwrap()["json"].to_string(),
                ),
                2 => (307, format!("location: {foreign}/capture\r\n"), "{}".into()),
                _ => (500, String::new(), flow("authorization_pending")),
            }
        });
        let dir = tempfile::tempdir().unwrap();
        remote(dir.path(), "login", &server.origin)
            .assert()
            .failure();
        assert!(!dir.path().join("data/credentials").exists());
        assert_eq!(server.seen.lock().unwrap().len(), 2);
    }
    assert!(target.seen.lock().unwrap().is_empty());
}

#[test]
fn deadline_stops_before_an_exchange_and_https_is_default() {
    let server = Server::new(|_, _, origin| (200, String::new(), start(origin, 2, 1)));
    let dir = tempfile::tempdir().unwrap();
    cli(dir.path())
        .args(["login", "--server", &server.origin])
        .assert()
        .failure();
    assert!(server.seen.lock().unwrap().is_empty());
    remote(dir.path(), "login", &server.origin)
        .assert()
        .failure();
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[test]
fn lost_consumed_response_does_not_retry_exchange() {
    let server = Server::new(|i, _, origin| {
        (
            200,
            String::new(),
            if i == 0 {
                start(origin, 1, 30)
            } else {
                "{".into()
            },
        )
    });
    let dir = tempfile::tempdir().unwrap();
    let out = remote(dir.path(), "login", &server.origin)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(server.seen.lock().unwrap().len(), 2);
    assert!(String::from_utf8_lossy(&out.stderr).contains("new login"));
}

pub fn start(origin: &str, interval: u64, expires: u64) -> String {
    serde_json::json!({"device_code":"disposable-device-canary", "user_code":"ABCD1234",
        "verification_uri":format!("{origin}/en-US/device"),
        "verification_uri_complete":format!("{origin}/en-US/device?user_code=ABCD1234"),
        "expires_in":expires, "interval":interval})
    .to_string()
}
pub fn flow(tag: &str) -> String {
    serde_json::json!({"json":{"defined":false,"code":"BAD_REQUEST","status":400,
        "message":"disposable-server-message-canary", "data":{"error":tag}}})
    .to_string()
}
pub fn success(origin: &str) -> String {
    serde_json::json!({"json":{"credentialId":"id", "userId":"user",
        "secret":"disposable-pat-canary", "expiresAt":"2027-01-01T00:00:00Z",
        "resource":format!("{origin}/mcp")}})
    .to_string()
}

#[test]
fn every_rpc_auth_request_sends_the_orpc_csrf_header() {
    let server = Server::new(|i, wire, _| {
        let headers = wire.split("\r\n\r\n").next().unwrap();
        assert!(
            headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("x-csrf-token: orpc"))
        );
        if i == 0 {
            assert!(wire.starts_with("POST /rpc/cliCredentials/exchangeDeviceCode "));
            (400, String::new(), flow("authorization_pending"))
        } else {
            assert!(wire.starts_with("POST /rpc/cliCredentials/registerDeviceRecipient "));
            (200, String::new(), "{}".into())
        }
    });
    let resource = McpResource::parse(&server.origin, TransportPolicy::AllowLoopbackHttp).unwrap();
    let remote = kb::auth::Remote::new(resource, None).unwrap();
    let key = kb_client::sealed::RecipientKey::from_bytes(
        kb_client::types::Uuid::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
        [7; 32],
    );
    kb::runtime().unwrap().block_on(async {
        assert!(matches!(
            remote
                .exchange("disposable-device-canary", "fixture")
                .await
                .unwrap(),
            kb::auth::Poll::Pending
        ));
        remote
            .register_recipient("disposable-device-canary", &key)
            .await
            .unwrap();
    });
    assert_eq!(server.seen.lock().unwrap().len(), 2);
}

#[test]
fn stalled_exchange_is_cancelled_at_device_deadline_without_retry_or_state() {
    let (release, response) = std::sync::mpsc::channel();
    let server = Server::new(move |i, _, origin| {
        if i == 0 {
            (200, String::new(), start(origin, 1, 3))
        } else {
            // Hold the response until the actual CLI exits. A real missing
            // cancellation hits the CLI watchdog, rather than a fixture sleep.
            let _ = response.recv();
            (200, String::new(), success(origin))
        }
    });
    // Drop before Server::drop on unwind, releasing its blocked response thread.
    let release = release;
    let dir = tempfile::tempdir().unwrap();
    // Keep the cancellation watchdog independent of durable-save scheduling.
    let out = remote(dir.path(), "login", &server.origin)
        .timeout(Duration::from_secs(30))
        .assert()
        .failure()
        .get_output()
        .clone();
    release.send(()).unwrap();
    // The exact three-second bound is asserted by the paused-clock test at the
    // production polling boundary; this test owns real HTTP cancellation/state.
    assert!(String::from_utf8_lossy(&out.stderr).contains("outcome is unknown"));
    assert_eq!(server.seen.lock().unwrap().len(), 2);
    assert!(!dir.path().join("data/credentials").exists());
}
