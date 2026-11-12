//! Task 61 private input/parser boundary, with an unavailable disposable bus.
#[path = "../crates/kb-local/tests/support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;
use kb_client::{decode_input, types::BasesCreate};
use kb_local::Store;
use std::{
    io::Write,
    process::{Command, Stdio},
};
const CANARY: &str = "disposable-sealed-stdin-canary-λ";
#[test]
fn stdin_canary_is_never_argv_stdout_stderr_or_state_even_on_native_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    let s = Store::open(&root).unwrap();
    let kb=s.bases_create(&s.owner(),decode_input::<BasesCreate>(serde_json::json!({"name":"Sealed","slug":"sealed","description":"Disposable CLI fixture","idempotencyKey":"create-sealed-cli"})).unwrap()).unwrap().kb;
    let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("kb"));
    cmd.args(["-vv", "--log-format", "json", "sealed", "--root"])
        .arg(&root)
        .args([
            "enroll",
            "--kb",
            kb.id.as_str(),
            "--idempotency-key",
            "enroll-cli-001",
            "--stdin",
        ])
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}/absent-bus", tmp.path().display()),
        )
        .env("XDG_RUNTIME_DIR", tmp.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    assert!(!format!("{cmd:?}").contains(CANARY));
    let mut child = ChildGuard::spawn_capture(&cmd).unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(CANARY.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    #[cfg(target_os = "linux")]
    assert!(!out.status.success());
    if out.status.success() {
        let reference = String::from_utf8(out.stdout.clone())
            .unwrap()
            .trim()
            .lines()
            .last()
            .unwrap()
            .parse()
            .unwrap();
        let keys = kb_local::credentials::NativeCredentials::new(
            assert_cmd::cargo::cargo_bin!("kb").into(),
        );
        s.sealed_revoke(&s.owner(), &kb.id, &reference, "cleanup-cli-001")
            .unwrap();
        kb_local::credentials::Credentials::delete(&keys, &format!("sealed-{}", s.store_uuid()))
            .unwrap();
    }
    for bytes in [&out.stdout, &out.stderr] {
        assert!(!String::from_utf8_lossy(bytes).contains(CANARY));
    }
    for suffix in ["", "-wal", "-shm"] {
        if let Ok(bytes) = std::fs::read(root.join(format!("state.sqlite{suffix}"))) {
            assert!(!bytes.windows(CANARY.len()).any(|s| s == CANARY.as_bytes()));
        }
    }
}
#[test]
fn input_is_private_bounded_exact_utf8_and_control_is_not_a_tool() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("literal");
    std::fs::write(&file, CANARY).unwrap();
    #[cfg(windows)]
    {
        // Same owner-only protected ACL as state.rs; test fixture only.
        let mut child = ChildGuard::new(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", r"$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.FileSecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a"])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
        child
            .stdin
            .take()
            .unwrap()
            .write_all(file.to_str().unwrap().as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let literal = kb::auth::import_sealed_literal(Some(&file)).unwrap();
    assert_eq!(literal.expose(), CANARY.as_bytes());
    std::fs::write(&file, "\0".repeat(16384)).unwrap();
    assert_eq!(
        kb::auth::import_sealed_literal(Some(&file))
            .unwrap()
            .expose()
            .len(),
        16384
    );
    std::fs::write(&file, "λ".repeat(8193)).unwrap();
    assert!(kb::auth::import_sealed_literal(Some(&file)).is_err());
    std::fs::write(&file, [0xff]).unwrap();
    assert!(kb::auth::import_sealed_literal(Some(&file)).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&file, CANARY).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(kb::auth::import_sealed_literal(Some(&file)).is_err());
    }
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/api/src/lib/kb/protocol/schema.json"
    ))
    .unwrap();
    assert!(!source.contains("knowledge_sealed_enroll"));
    assert!(!source.contains("knowledge_sealed_grant"));
    assert!(!source.contains("knowledge_sealed_revoke"));
    let help = Command::new(assert_cmd::cargo::cargo_bin!("kb"))
        .args(["sealed", "--root", "unused", "enroll", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("--stdin"));
    assert!(text.contains("--file"));
    assert!(!text.contains("--plaintext"));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an isolated, unlocked Secret Service session"]
fn isolated_native_cli_lifecycle_replays_and_preserves_symbolic_source() {
    use kb_client::{
        sealed::{RecipientKey, open_envelope},
        types::*,
    };
    use kb_local::{
        credentials::{Credentials, NativeCredentials},
        embedder::ProviderControl,
        sealed::ControlReply,
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("store");
    let s = Store::open(&root).unwrap();
    let kb=s.bases_create(&s.owner(),decode_input::<BasesCreate>(serde_json::json!({"name":"Native sealed","slug":"native-sealed","description":"Disposable native CLI lifecycle", "idempotencyKey":"create-native-cli-001"})).unwrap()).unwrap().kb;
    let run = |args: &[&str], stdin: Option<&str>| -> ControlReply {
        let mut cmd = Command::new(assert_cmd::cargo::cargo_bin!("kb"));
        cmd.args(["sealed", "--root"])
            .arg(&root)
            .args(["--json"])
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        assert!(!format!("{cmd:?}").contains(CANARY));
        let mut child = ChildGuard::spawn_capture(&cmd).unwrap();
        if let Some(literal) = stdin {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(literal.as_bytes())
                .unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        for bytes in [&out.stdout, &out.stderr] {
            assert!(!String::from_utf8_lossy(bytes).contains(CANARY));
        }
        serde_json::from_slice(&out.stdout).unwrap()
    };
    let enroll = [
        "enroll",
        "--kb",
        kb.id.as_str(),
        "--idempotency-key",
        "native-enroll-001",
        "--stdin",
    ];
    let first = run(&enroll, Some(CANARY));
    let replay = run(&enroll, Some(CANARY));
    assert_eq!(first.operation_id, replay.operation_id);
    let r = first.reference.parse().unwrap();
    let rev=s.documents_create(&s.owner(),decode_input::<DocumentsCreate>(serde_json::json!({"kbId":kb.id,"baseRevision":kb.head_sha,"idempotencyKey":"native-source-001","path":"secret.md","content":{"markdown":first.reference}})).unwrap()).unwrap().commit_sha;
    let recipient = RecipientKey::from_bytes(
        "00000000-0000-4000-8000-000000000003".parse().unwrap(),
        [2; 32],
    );
    // Typed by a person: the unpadded URL-safe spelling is accepted (R3-L12).
    let public = recipient
        .public_key_base64()
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_");
    let owner = s.owner();
    let grant = [
        "grant",
        "--kb",
        kb.id.as_str(),
        "--idempotency-key",
        "native-grant-001",
        "--reference",
        &first.reference,
        "--consumer-id",
        owner.id(),
        "--recipient-key-id",
        recipient.id().as_str(),
        "--recipient-public-key",
        &public,
        "--expires-at",
        "2099-01-01T00:00:00Z",
    ];
    let approved = run(&grant, None);
    assert_eq!(approved.operation_id, run(&grant, None).operation_id);
    let keys = NativeCredentials::new(assert_cmd::cargo::cargo_bin!("kb").into());
    let account = format!("sealed-{}", s.store_uuid());
    let key_before = keys.get(&account).unwrap();
    let reopened = Store::open(&root).unwrap();
    let input = SealedResolveInput {
        kb_id: kb.id.clone(),
        rev: Some(rev.clone()),
        path: "secret.md".parse().unwrap(),
        reference: first.reference.clone(),
        recipient_key_id: recipient.id().clone(),
    };
    let out = reopened
        .sealed_resolve(
            &reopened.owner(),
            input.clone(),
            &keys,
            &ProviderControl::default(),
        )
        .unwrap();
    assert_eq!(
        open_envelope(&recipient, &r, &out, std::time::SystemTime::now())
            .unwrap()
            .expose_str(),
        Some(CANARY)
    );
    assert_eq!(keys.get(&account).unwrap().expose(), key_before.expose());
    let revoke = [
        "revoke",
        "--kb",
        kb.id.as_str(),
        "--idempotency-key",
        "native-revoke-001",
        "--reference",
        &first.reference,
    ];
    let retired = run(&revoke, None);
    assert!(retired.revoked);
    assert_eq!(retired.operation_id, run(&revoke, None).operation_id);
    assert_eq!(
        reopened
            .sealed_resolve(&reopened.owner(), input, &keys, &ProviderControl::default())
            .err()
            .unwrap()
            .protocol_code(),
        kb_client::ErrorCode::UnresolvedReference
    );
    let doc = reopened
        .documents_get(
            &reopened.owner(),
            DocumentsGetInput {
                kb_id: kb.id,
                rev: Some(rev),
                path: "secret.md".parse().unwrap(),
            },
        )
        .unwrap();
    assert!(doc.markdown.contains(&first.reference));
    for suffix in ["", "-wal", "-shm"] {
        if let Ok(bytes) = std::fs::read(root.join(format!("state.sqlite{suffix}"))) {
            assert!(!bytes.windows(CANARY.len()).any(|s| s == CANARY.as_bytes()));
        }
    }
    keys.delete(&account).unwrap();
}
