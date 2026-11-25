//! knowledge_search_all across every server.

use super::*;

// ── knowledge_search_all without `server`: every server at once ────────────

const KB_C: &str = "cccccccccccccccccccccccc";
const KB_H: &str = "hhhhhhhhhhhhhhhhhhhhhhhh";
const KB_X: &str = "xxxxxxxxxxxxxxxxxxxxxxxx";
const KB_UNKNOWN: &str = "uuuuuuuuuuuuuuuuuuuuuuuu";

/// Serve each fake (concurrently) under the next label, its credential saved.
fn serve_all(fakes: Vec<Fake>) -> (Vec<Server>, tempfile::TempDir) {
    let dir = support::canonical_tempdir();
    let servers = fakes
        .into_iter()
        .zip(LABELS)
        .map(|(fake, label)| {
            let server = fake.serve_concurrently();
            save(dir.path(), &server.origin, label);
            server
        })
        .collect();
    (servers, dir)
}
/// `kb mcp` over `origins`, named by [`LABELS`] in order.
fn start_all(dir: &Path, origins: &[&str]) -> Peer {
    let names: Vec<String> = origins
        .iter()
        .zip(LABELS)
        .map(|(origin, label)| format!("{label}={origin}"))
        .collect();
    let mut args = vec!["mcp"];
    for name in &names {
        args.extend(["--server", name.as_str()]);
    }
    args.push("--allow-loopback-http");
    Peer::start(dir, &args)
}
/// The `knowledge_search_all` calls a server received (their arguments).
fn searches(server: &Server) -> Vec<Value> {
    calls(server)
        .into_iter()
        .filter(|call| call["params"]["name"] == "knowledge_search_all")
        .map(|call| call["params"]["arguments"].clone())
        .collect()
}
/// A federated search's result: a success matching the advertised output
/// schema, not labelled with any one server.
fn everywhere(peer: &mut Peer, arguments: Value) -> Value {
    let tools = peer.tools();
    let schema = row(&tools, "knowledge_search_all")["outputSchema"].clone();
    let reply = peer.call("knowledge_search_all", arguments);
    assert_eq!(reply["isError"], false, "{reply}");
    assert!(reply["_meta"].get("kb/server").is_none(), "{reply}");
    assert!(
        kb_client::schema::conforms(&schema, &reply["structuredContent"]),
        "{reply}"
    );
    let text: Value = serde_json::from_str(reply["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text, reply["structuredContent"]);
    reply["structuredContent"]["data"].clone()
}

/// Each server row as (server, status, code).
fn statuses(data: &Value) -> Vec<(String, String, Value)> {
    data["servers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["server"].as_str().unwrap().to_owned(),
                row["status"].as_str().unwrap().to_owned(),
                row["code"].clone(),
            )
        })
        .collect()
}

#[test]
fn a_search_without_server_reaches_every_server_and_stamps_each_hit() {
    let (servers, dir) = serve_all(vec![
        Fake::full(&[KB_A]),
        Fake::full(&[KB_B]),
        Fake::full(&[KB_C]),
    ]);
    let origins: Vec<&str> = servers.iter().map(|s| s.origin.as_str()).collect();
    let mut peer = start_all(dir.path(), &origins);
    let instructions = peer.request("server/discover", json!({}))["result"]["instructions"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        instructions.contains(
            "knowledge_search_all without `server` sends its query to every server that takes part"
        ),
        "{instructions}"
    );
    let tools = peer.tools();
    let all = row(&tools, "knowledge_search_all");
    assert_eq!(all["inputSchema"]["required"], json!(["query"]));
    assert_eq!(
        all["inputSchema"]["properties"]["server"],
        json!({"type":"string","enum":["a","b","c"]})
    );
    assert_eq!(all["description"], kb::federated::DESCRIPTION);
    assert_eq!(
        all["outputSchema"]["properties"]["data"]["anyOf"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let data = everywhere(&mut peer, json!({"query":"x"}));
    // Every base's first hit in server order, then every second, ...
    let mut expected = Vec::new();
    for rank in 1..=4 {
        for (server, kb) in [("a", KB_A), ("b", KB_B), ("c", KB_C)] {
            expected.push(hit(server, kb, rank));
        }
    }
    assert_eq!(hits(&data), expected);
    assert_eq!(data["order"], "rank_interleaved");
    assert_eq!(data["limitPerBase"], 4);
    assert_eq!(
        bases(&data),
        [
            base("a", KB_A, "ok", 4),
            base("b", KB_B, "ok", 4),
            base("c", KB_C, "ok", 4)
        ]
    );
    assert_eq!(
        statuses(&data),
        [
            status("a", "ok", None),
            status("b", "ok", None),
            status("c", "ok", None)
        ]
    );
    assert!(
        data["servers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["baseCount"] == 1)
    );
    // Each server got the query and its share, never a `server` argument.
    for server in &servers {
        assert_eq!(searches(server), [json!({"query":"x","limitPerBase":4})]);
    }
    // A federated reply teaches no kbId: A's row for its base does not make
    // that base A's, so a named call of it on B still reaches B.
    let reached = peer.ok(
        "knowledge_documents_get",
        json!({"server":"b","kbId":KB_A,"path":"docs/guide.md"}),
    );
    assert!(reached.is_object());
    assert_eq!(calls(&servers[1]).len(), 2);

    // Naming a server forwards to it alone and returns its own reply.
    let own = peer.call("knowledge_search_all", json!({"server":"b","query":"y"}));
    assert_eq!(own["_meta"]["kb/server"], "b");
    let (_, expected) = searched(&[KB_B], &json!({"query":"y"}));
    assert_eq!(own["structuredContent"], expected["structuredContent"]);
    assert!(kb_client::schema::conforms(
        &all["outputSchema"],
        &own["structuredContent"]
    ));
    assert_eq!(searches(&servers[1]).last().unwrap(), &json!({"query":"y"}));
    assert_eq!(searches(&servers[0]).len(), 1);
    peer.close();
    only_own_token(&servers[0], "a", "b");
    only_own_token(&servers[2], "c", "a");
}

#[test]
fn opted_out_servers_and_unshown_kb_ids_get_no_query() {
    let (servers, dir) = serve_all(vec![
        Fake::full(&[KB_A, KB_SHARED]),
        Fake::full(&[KB_B, KB_SHARED]),
        Fake::full(&[KB_C]),
    ]);
    let kb = |args: &[&str]| cli(dir.path()).args(args).assert().success();
    for (label, server) in LABELS.into_iter().zip(&servers) {
        let mut args = vec![
            "config",
            "add-server",
            label,
            &server.origin,
            "--allow-loopback-http",
        ];
        if label == "c" {
            args.push("--no-search-all");
        }
        kb(&args);
    }
    let shown: Value = serde_json::from_slice(
        &cli(dir.path())
            .args(["config", "show", "--json"])
            .assert()
            .success()
            .get_output()
            .stdout,
    )
    .unwrap();
    assert_eq!(shown["servers"]["c"]["search_all"], false);
    assert!(shown["servers"]["a"].get("search_all").is_none());
    let mut peer = Peer::start(
        dir.path(),
        &["mcp", "--server", "a", "--server", "b", "--server", "c"],
    );
    for label in ["a", "b", "c"] {
        peer.ok("knowledge_bases_list", json!({"server":label}));
    }
    // Each ID goes only to the servers that showed it; C opted out, so its
    // KB, like one nobody showed, is sent nowhere.
    let data = everywhere(
        &mut peer,
        json!({"query":"x","kbIds":[KB_A, KB_SHARED, KB_C, KB_UNKNOWN, KB_A]}),
    );
    assert_eq!(
        searches(&servers[0]),
        [json!({"query":"x","limitPerBase":4,"kbIds":[KB_A, KB_SHARED]})]
    );
    assert_eq!(
        searches(&servers[1]),
        [json!({"query":"x","limitPerBase":4,"kbIds":[KB_SHARED]})]
    );
    assert!(searches(&servers[2]).is_empty(), "opted out");
    assert_eq!(
        hits(&data)[..3],
        [
            hit("a", KB_A, 1),
            hit("a", KB_SHARED, 1),
            hit("b", KB_SHARED, 1)
        ]
    );
    assert_eq!(hits(&data).len(), 12);
    assert_eq!(
        bases(&data),
        [
            base("a", KB_A, "ok", 4),
            base("a", KB_SHARED, "ok", 4),
            base("b", KB_SHARED, "ok", 4),
            base("-", KB_C, "not_found", 0),
            base("-", KB_UNKNOWN, "not_found", 0),
        ]
    );
    assert_eq!(
        statuses(&data),
        [status("a", "ok", None), status("b", "ok", None)]
    );
    // A server none of the IDs goes to is not asked (or listed).
    let data = everywhere(&mut peer, json!({"query":"x","kbIds":[KB_B]}));
    assert_eq!(statuses(&data), [status("b", "ok", None)]);
    assert_eq!(searches(&servers[0]).len(), 1);
    // Naming the opted-out server still reaches it.
    peer.ok("knowledge_search_all", json!({"server":"c","query":"x"}));
    assert_eq!(searches(&servers[2]), [json!({"query":"x"})]);
    peer.close();
}

#[test]
fn every_failing_server_gets_its_own_status_and_forged_hits_are_dropped() {
    use kb_client::{ErrorCode, error::tool_error};
    // H names a base it has no row for and one it says it did not find.
    let forge = |kbs: &[&'static str], arguments: &Value| {
        let (status, mut result) = searched(kbs, arguments);
        let data = &mut result["structuredContent"]["data"];
        for kb in [KB_A, KB_X] {
            let mut forged = data["results"][0].clone();
            forged["knowledgeBaseId"] = json!(kb);
            forged["snippet"] = json!(format!("forged {kb}"));
            data["results"].as_array_mut().unwrap().insert(0, forged);
        }
        let mut row = data["knowledgeBases"][0].clone();
        row["kbId"] = json!(KB_X);
        row["status"] = json!("not_found");
        for key in ["generationId", "freshness", "indexedCommitSha", "headSha"] {
            row[key] = Value::Null;
        }
        row["hitCount"] = json!(0);
        data["knowledgeBases"].as_array_mut().unwrap().push(row);
        (status, tool_result(result["structuredContent"].clone()))
    };
    let revoked = Fake::full(&["ffffffffffffffffffffffff"]);
    let revoke = revoked.revoked.clone();
    let (servers, dir) = serve_all(vec![
        Fake::full(&[KB_A]),
        // B answers with data that is not the pinned shape.
        Fake::full(&[KB_B]).searching(|_, _| {
            (
                200,
                tool_result(json!({"schemaVersion":"kb/1","data":{"results":"nope"}})),
            )
        }),
        Fake::full(&[KB_C]).searching(|_, _| {
            (
                200,
                tool_error(
                    ErrorCode::InvalidArgument,
                    json!({"reason":"TOO_MANY_BASES","max":16}),
                ),
            )
        }),
        Fake::full(&["dddddddddddddddddddddddd"]).searching(|_, _| {
            (
                200,
                tool_error(ErrorCode::RateLimited, json!({"retryAfterSeconds":30})),
            )
        }),
        // E predates the tool.
        Fake::full(&["eeeeeeeeeeeeeeeeeeeeeeee"])
            .only(&["knowledge_bases_list", "knowledge_search"], None),
        revoked,
        Fake::full(&[KB_H]).searching(forge),
    ]);
    // G is down from the start.
    let gone = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    save(dir.path(), &gone, "g");
    let mut origins: Vec<&str> = servers.iter().map(|s| s.origin.as_str()).collect();
    origins.insert(6, &gone);
    let mut peer = start_all(dir.path(), &origins);
    revoke.store(true, SeqCst);
    let data = everywhere(&mut peer, json!({"query":"x"}));
    assert_eq!(
        statuses(&data),
        [
            status("a", "ok", None),
            status("b", "unavailable", Some("INTERNAL")),
            status("c", "too_many_bases", Some("INVALID_ARGUMENT")),
            status("d", "rate_limited", Some("RATE_LIMITED")),
            status("e", "unsupported", None),
            status("f", "logged_out", Some("FORBIDDEN")),
            status("g", "unavailable", Some("STORAGE_UNAVAILABLE")),
            status("h", "ok", None),
        ]
    );
    assert_eq!(data["servers"][2]["max"], 16);
    assert_eq!(data["servers"][3]["retryAfterSeconds"], 30);
    // Six servers were asked: each base gets min(4, 100 / 6) hits.
    assert_eq!(data["limitPerBase"], 4);
    assert!(searches(&servers[4]).is_empty(), "E does not list the tool");
    // Only A's and H's own searched bases contribute, each stamped by the CLI.
    let mut expected = Vec::new();
    for rank in 1..=4 {
        expected.push(hit("a", KB_A, rank));
        expected.push(hit("h", KB_H, rank));
    }
    assert_eq!(hits(&data), expected);
    assert_eq!(
        bases(&data),
        [
            base("a", KB_A, "ok", 4),
            base("h", KB_H, "ok", 4),
            base("h", KB_X, "not_found", 0)
        ]
    );
    // With kbIds, a row (and hit) for a base H was not sent is dropped too.
    // H's federated rows taught nothing; its list shows KB_H, never KB_X.
    peer.ok("knowledge_bases_list", json!({"server":"h"}));
    let data = everywhere(&mut peer, json!({"query":"x","kbIds":[KB_H, KB_X]}));
    assert_eq!(
        searches(&servers[6]).last().unwrap()["kbIds"],
        json!([KB_H])
    );
    assert_eq!(
        bases(&data),
        [base("h", KB_H, "ok", 4), base("-", KB_X, "not_found", 0)]
    );
    assert!(
        hits(&data)
            .iter()
            .all(|(server, kb, _)| server == "h" && kb == KB_H)
    );
    assert_eq!(
        statuses(&data),
        [
            status("e", "unsupported", None),
            status("g", "unavailable", Some("STORAGE_UNAVAILABLE")),
            status("h", "ok", None),
        ]
    );
    let stderr = peer.close();
    assert!(stderr.contains("run `kb login --server f`"), "{stderr}");
    assert!(!stderr.contains("disposable-multi-canary"));
    assert!(!stderr.contains("\"x\""), "the query is never logged");
}

#[test]
fn a_busy_server_is_skipped_and_a_cancelled_search_gives_its_slots_back() {
    let hung = Fake::full(&[KB_B]);
    let hold = hung.hold.clone();
    let (servers, dir) = serve_all(vec![Fake::full(&[KB_A]), hung]);
    let b = &servers[1];
    let origins: Vec<&str> = servers.iter().map(|s| s.origin.as_str()).collect();
    let mut peer = start_all(dir.path(), &origins);
    let list_b = json!({"name":"knowledge_bases_list","arguments":{"server":"b"}});
    let search = json!({"name":"knowledge_search_all","arguments":{"query":"x"}});
    // B's three slots are taken: the search skips it without a call.
    hold.store(true, SeqCst);
    for _ in 0..3 {
        peer.send("tools/call", list_b.clone());
    }
    received(b, 3);
    let reply = peer.request("tools/call", search.clone());
    let data = &reply["result"]["structuredContent"]["data"];
    assert_eq!(
        statuses(data),
        [
            status("a", "ok", None),
            status("b", "busy", Some("STORAGE_UNAVAILABLE"))
        ]
    );
    assert_eq!(calls(b).len(), 3, "no call to a busy server");
    hold.store(false, SeqCst);
    for _ in 0..3 {
        assert_eq!(peer.next()["result"]["isError"], false);
    }
    // A cancelled search answers CANCELLED once its calls are joined, and
    // leaves no slot counted: B then takes three calls again.
    hold.store(true, SeqCst);
    let cancelled = peer.send("tools/call", search);
    received(b, 4);
    peer.send_notification("notifications/cancelled", json!({"requestId": cancelled}));
    let reply = peer
        .replies
        .recv_timeout(Duration::from_secs(5))
        .expect("prompt cancellation");
    assert_eq!(reply["id"], cancelled);
    assert_eq!(
        reply["result"]["structuredContent"]["error"]["code"],
        "CANCELLED"
    );
    for _ in 0..3 {
        peer.send("tools/call", list_b.clone());
    }
    received(b, 7);
    let fourth = peer.send("tools/call", list_b);
    let refused = peer.next();
    assert_eq!(refused["id"], fourth);
    assert_eq!(
        refused["result"]["structuredContent"]["error"]["code"],
        "STORAGE_UNAVAILABLE"
    );
    hold.store(false, SeqCst);
    for _ in 0..3 {
        assert_eq!(peer.next()["result"]["isError"], false);
    }
    peer.close();
}

#[test]
fn a_federated_reply_never_claims_a_base_for_its_server() {
    use kb_client::{ErrorCode, error::tool_error};
    // A claims B's base in its own rows (and hits) while B, rate limited on
    // its "all", has not shown it yet.
    let hostile = Fake::full(&[KB_A]).searching(|_, arguments| searched(&[KB_B], arguments));
    let limited = Fake::full(&[KB_B]).searching(|kbs, arguments| {
        if arguments.get("kbIds").is_some() {
            searched(kbs, arguments)
        } else {
            (
                200,
                tool_error(ErrorCode::RateLimited, json!({"retryAfterSeconds":5})),
            )
        }
    });
    let (servers, dir) = serve_all(vec![hostile, limited]);
    let origins: Vec<&str> = servers.iter().map(|s| s.origin.as_str()).collect();
    let mut peer = start_all(dir.path(), &origins);
    let data = everywhere(&mut peer, json!({"query":"x"}));
    assert_eq!(bases(&data), [base("a", KB_B, "ok", 4)]);
    assert_eq!(
        statuses(&data),
        [
            status("a", "ok", None),
            status("b", "rate_limited", Some("RATE_LIMITED"))
        ]
    );
    // B is still asked about its own base by name, and its reply teaches it.
    let own = peer.ok(
        "knowledge_search_all",
        json!({"server":"b","query":"y","kbIds":[KB_B]}),
    );
    assert_eq!(own["knowledgeBases"][0]["kbId"], KB_B);
    assert_eq!(
        searches(&servers[1]).last().unwrap(),
        &json!({"query":"y","kbIds":[KB_B]})
    );
    peer.ok(
        "knowledge_documents_get",
        json!({"server":"b","kbId":KB_B,"path":"docs/guide.md"}),
    );
    // Now B has shown it and A never has: the base goes to B only, and A
    // (which nothing routes to) is not asked.
    let data = everywhere(&mut peer, json!({"query":"x","kbIds":[KB_B]}));
    assert_eq!(bases(&data), [base("b", KB_B, "ok", 4)]);
    assert_eq!(searches(&servers[0]).len(), 1);
    assert_eq!(
        searches(&servers[1]).last().unwrap(),
        &json!({"query":"x","limitPerBase":4,"kbIds":[KB_B]})
    );
    // And by name it is refused on A, which never showed it.
    let refused = peer.call(
        "knowledge_search_all",
        json!({"server":"a","query":"x","kbIds":[KB_B]}),
    );
    assert_eq!(refused["structuredContent"]["error"]["code"], "FORBIDDEN");
    assert_eq!(searches(&servers[0]).len(), 1);
    peer.close();
}

#[test]
fn large_replies_share_the_merged_budget_instead_of_overflowing_it() {
    // Each server's four hits carry ~600 KiB of matched row: ~2.4 MiB of
    // schema-valid data per server, past the merged reply's 8 MiB frame
    // once both are merged and encoded twice.
    let heavy = |kbs: &[&'static str], arguments: &Value| {
        let (status, mut result) = searched(kbs, arguments);
        let mut matched = serde_json::Map::new();
        for key in 0..600 {
            matched.insert(format!("c{key}"), json!("m".repeat(1024)));
        }
        let data = &mut result["structuredContent"]["data"];
        for hit in data["results"].as_array_mut().unwrap() {
            hit["matchedRow"] = Value::Object(matched.clone());
        }
        (status, tool_result(result["structuredContent"].clone()))
    };
    let (servers, dir) = serve_all(vec![
        Fake::full(&[KB_A]).searching(heavy),
        Fake::full(&[KB_B]).searching(heavy),
        Fake::full(&[KB_C]),
    ]);
    let origins: Vec<&str> = servers.iter().map(|s| s.origin.as_str()).collect();
    let mut peer = start_all(dir.path(), &origins);
    let data = everywhere(&mut peer, json!({"query":"x"}));
    let truncated: Vec<&Value> = data["servers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|server| &server["truncated"])
        .collect();
    assert_eq!(truncated, [true, true, false]);
    assert_eq!(
        statuses(&data),
        [
            status("a", "ok", None),
            status("b", "ok", None),
            status("c", "ok", None)
        ]
    );
    // A and B keep their top hits; C, small, keeps all four.
    let rows = bases(&data);
    assert!((1..4).contains(&rows[0].3), "{rows:?}");
    assert_eq!(rows[0].3, rows[1].3);
    assert_eq!(rows[2], base("c", KB_C, "ok", 4));
    let kept = hits(&data);
    assert_eq!(kept.len(), usize::try_from(rows[0].3 * 2 + 4).unwrap());
    assert_eq!(
        kept[..3],
        [hit("a", KB_A, 1), hit("b", KB_B, 1), hit("c", KB_C, 1)]
    );
    peer.close();
}

#[test]
fn search_is_listed_and_reports_statuses_when_no_server_at_startup_lists_it() {
    // A predates the tool; B is down from the start.
    let (servers, dir) = serve_all(vec![
        Fake::full(&[KB_A]).only(&["knowledge_bases_list", "knowledge_search"], None),
    ]);
    let gone = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    save(dir.path(), &gone, "b");
    let mut peer = start_all(dir.path(), &[servers[0].origin.as_str(), gone.as_str()]);
    let tools = peer.tools();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    // A's two tools and the federated search, in catalog order.
    let listed = [
        "knowledge_bases_list",
        "knowledge_search",
        "knowledge_search_all",
    ];
    let order: Vec<&str> = ToolName::ALL
        .iter()
        .map(|name| name.as_str())
        .filter(|name| listed.contains(name))
        .collect();
    assert_eq!(names, order);
    let all = row(&tools, "knowledge_search_all");
    assert_eq!(all["description"], kb::federated::DESCRIPTION);
    assert_eq!(all["inputSchema"]["required"], json!(["query"]));
    assert!(all["inputSchema"]["properties"].get("server").is_none());
    let data = everywhere(&mut peer, json!({"query":"x"}));
    assert_eq!(data["results"], json!([]));
    assert_eq!(
        statuses(&data),
        [
            status("a", "unsupported", None),
            status("b", "unavailable", Some("STORAGE_UNAVAILABLE"))
        ]
    );
    assert!(searches(&servers[0]).is_empty());
    // Naming a server that does not list it is an unknown tool, as before.
    let named = peer.request(
        "tools/call",
        json!({"name":"knowledge_search_all","arguments":{"server":"a","query":"x"}}),
    );
    assert_eq!(named["error"]["code"], -32602, "{named}");
    assert!(calls(&servers[0]).is_empty());
    peer.close();
}
