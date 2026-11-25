//! Per-server credentials.

use super::*;

#[test]
fn two_processes_share_the_credential_store_without_crossing_tokens() {
    let (a, b, dir) = pair(Fake::full(&[KB_A]), Fake::full(&[KB_B]));
    let mut one = start(dir.path(), &a, &b, &[]);
    let mut two = start(dir.path(), &a, &b, &[]);
    for _ in 0..3 {
        for peer in [&mut one, &mut two] {
            for server in ["a", "b"] {
                let reply = peer.call("knowledge_bases_list", json!({"server":server}));
                assert_eq!(reply["_meta"]["kb/server"], server);
            }
        }
    }
    one.close();
    two.close();
    assert_eq!(calls(&a).len(), 6);
    assert_eq!(calls(&b).len(), 6);
    only_own_token(&a, "a", "b");
    only_own_token(&b, "b", "a");
}

#[test]
fn a_revoked_credential_fails_only_its_server_and_never_borrows_another() {
    let b = Fake::full(&[KB_B]);
    let revoked = b.revoked.clone();
    let (a, b, dir) = pair(Fake::full(&[KB_A]), b);
    let mut peer = start(dir.path(), &a, &b, &[]);
    peer.ok("knowledge_bases_list", json!({"server":"b"}));
    revoked.store(true, SeqCst);
    let reply = peer.call("knowledge_bases_list", json!({"server":"b"}));
    assert_eq!(reply["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert_eq!(reply["_meta"]["kb/server"], "b");
    peer.ok("knowledge_bases_list", json!({"server":"a"}));
    let stderr = peer.close();
    assert!(stderr.contains("run `kb login --server b`"), "{stderr}");
    assert!(!stderr.contains("disposable-multi-canary"));
    // B's refusal was answered by B alone: no retry, no other token.
    assert_eq!(calls(&b).len(), 2);
    only_own_token(&a, "a", "b");
    only_own_token(&b, "b", "a");
}
