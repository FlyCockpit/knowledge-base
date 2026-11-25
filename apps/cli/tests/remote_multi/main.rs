//! One `kb mcp` over several servers: the merged list, routing, isolation of
//! credentials and KB IDs, and per-server failures. Fixture servers only.
#![allow(clippy::unwrap_used)] // Fixture assertions.
#[path = "../../crates/kb-local/tests/support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;
#[allow(dead_code)] // Shared fixtures; this file uses a subset.
#[path = "../support/mod.rs"]
mod support;
use kb::state::CredentialStore;
use kb_client::{McpResource, SecretToken, ToolName, TransportPolicy, mcp::catalog::catalog};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering::SeqCst},
        mpsc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use support::{Server, cli};

const KB_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const KB_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";
const KB_SHARED: &str = "ssssssssssssssssssssssss";

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    ))
    .unwrap()
}
fn valid(name: &str) -> Value {
    fixture()["tools"][name]["validInput"].clone()
}
fn body(wire: &str) -> Value {
    serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap()
}
fn token(label: &str) -> String {
    format!("disposable-multi-canary-{label}")
}

/// A fixture server: its tool list, instructions, the KBs its list names,
/// and an optional delay before answering `tools/call`.
#[derive(Clone)]
struct Fake {
    tools: Value,
    instructions: Option<String>,
    kbs: Vec<&'static str>,
    delay: Duration,
    /// Answer `tools/call` with 401, as after `kb logout` revoked the PAT.
    revoked: Arc<AtomicBool>,
    /// Hold every `tools/call` until this is cleared (a hung server).
    hold: Arc<AtomicBool>,
    /// Take every `tools/call` and close without a reply (a lost reply).
    lose: Arc<AtomicBool>,
    /// Its own `knowledge_search_all` answer for the call's arguments: an
    /// HTTP status and the tool result (default: [`searched`]).
    search: Option<SearchReply>,
}
type SearchReply = Arc<dyn Fn(&[&'static str], &Value) -> (u16, Value) + Send + Sync>;

/// A tool result carrying `envelope` as its structured and text content.
fn tool_result(envelope: Value) -> Value {
    let is_error = envelope.get("error").is_some();
    json!({"isError":is_error,"structuredContent":envelope,"content":[{"type":"text","text":envelope.to_string()}]})
}
/// An honest `knowledge_search_all`: the requested bases (else every base the
/// server has), each `ok` with `limitPerBase` hits interleaved by rank; each
/// hit's snippet is `"<kbId> <rank>"`.
fn searched(kbs: &[&'static str], arguments: &Value) -> (u16, Value) {
    let ids: Vec<String> = match arguments["kbIds"].as_array() {
        Some(ids) => ids
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect(),
        None => kbs.iter().map(|kb| (*kb).to_owned()).collect(),
    };
    let limit = arguments["limitPerBase"].as_u64().unwrap_or(4);
    let template = fixture()["tools"]["knowledge_search_all"]["validOutputVariants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["label"] == "populated-hit")
        .unwrap()["value"]
        .clone();
    let mut results = Vec::new();
    for rank in 1..=limit {
        for id in &ids {
            let mut hit = template["results"][0].clone();
            hit["knowledgeBaseId"] = json!(id);
            hit["snippet"] = json!(format!("{id} {rank}"));
            hit["rank"] = json!(rank);
            results.push(hit);
        }
    }
    let rows: Vec<Value> = ids
        .iter()
        .map(|id| {
            let mut row = template["knowledgeBases"][0].clone();
            row["kbId"] = json!(id);
            row["hitCount"] = json!(limit);
            row
        })
        .collect();
    let data = json!({"results":results,"order":"rank_interleaved","limitPerBase":limit,"knowledgeBases":rows});
    (
        200,
        tool_result(json!({"schemaVersion":"kb/1","data":data})),
    )
}
impl Fake {
    fn full(kbs: &[&'static str]) -> Self {
        Self {
            tools: catalog().unwrap(),
            instructions: None,
            kbs: kbs.to_vec(),
            delay: Duration::ZERO,
            revoked: Arc::default(),
            hold: Arc::default(),
            lose: Arc::default(),
            search: None,
        }
    }
    fn searching(
        mut self,
        reply: impl Fn(&[&'static str], &Value) -> (u16, Value) + Send + Sync + 'static,
    ) -> Self {
        self.search = Some(Arc::new(reply));
        self
    }
    fn only(mut self, names: &[&str], kb_enum: Option<&[&str]>) -> Self {
        let mut tools: Vec<Value> = self
            .tools
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| names.contains(&t["name"].as_str().unwrap()))
            .cloned()
            .collect();
        if let Some(kbs) = kb_enum {
            for tool in &mut tools {
                if tool["inputSchema"]["properties"]["kbId"].is_object() {
                    tool["inputSchema"]["properties"]["kbId"]["enum"] = json!(kbs);
                }
            }
        }
        self.tools = Value::Array(tools);
        self
    }
    fn answer(&self, wire: &str) -> (u16, String, String) {
        let request = body(wire);
        let result = match request["method"].as_str().unwrap() {
            "server/discover" => {
                let mut value = json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}}});
                if let Some(text) = &self.instructions {
                    value["instructions"] = json!(text);
                }
                value
            }
            "tools/list" => json!({"resultType":"complete","tools":self.tools}),
            "tools/call" if self.revoked.load(SeqCst) => {
                return (401, String::new(), String::new());
            }
            "tools/call" if self.lose.load(SeqCst) => return (0, String::new(), String::new()),
            "tools/call" => {
                let until = Instant::now() + Duration::from_secs(30);
                while self.hold.load(SeqCst) && Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::thread::sleep(self.delay);
                let name = request["params"]["name"].as_str().unwrap();
                if name == "knowledge_search_all" {
                    let arguments = &request["params"]["arguments"];
                    let (status, result) = match &self.search {
                        Some(reply) => reply(&self.kbs, arguments),
                        None => searched(&self.kbs, arguments),
                    };
                    let mut result = result;
                    result["resultType"] = json!("complete");
                    return (
                        status,
                        String::new(),
                        json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string(),
                    );
                }
                let mut data = fixture()["tools"][name]["validOutput"].clone();
                if name == "knowledge_bases_list" {
                    let item = data["items"][0].clone();
                    data["items"] = Value::Array(
                        self.kbs
                            .iter()
                            .map(|kb| {
                                let mut item = item.clone();
                                item["id"] = json!(kb);
                                item
                            })
                            .collect(),
                    );
                }
                let envelope = json!({"schemaVersion":"kb/1","data":data});
                json!({"resultType":"complete","isError":false,"structuredContent":envelope,"content":[{"type":"text","text":envelope.to_string()}]})
            }
            _ => panic!("unexpected HTTP method"),
        };
        (
            200,
            String::new(),
            json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string(),
        )
    }
    fn serve(self) -> Server {
        Server::new(move |_, wire, _| self.answer(wire))
    }
    /// A server whose requests overlap (each on its own thread).
    fn serve_concurrently(self) -> Server {
        Server::concurrent(move |_, wire, _| self.answer(wire))
    }
}

fn save(dir: &Path, origin: &str, label: &str) {
    let resource = McpResource::parse(origin, TransportPolicy::AllowLoopbackHttp).unwrap();
    CredentialStore::new(dir.join("data/credentials"))
        .save(&resource, &SecretToken::new(token(label)))
        .unwrap();
}

struct Peer {
    child: ChildGuard,
    input: Option<ChildStdin>,
    replies: mpsc::Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    stderr: Arc<Mutex<String>>,
    stderr_reader: Option<JoinHandle<()>>,
    id: u64,
}
impl Peer {
    fn start(dir: &Path, args: &[&str]) -> Self {
        let mut child = ChildGuard::spawn_capture(
            Command::new(assert_cmd::cargo::cargo_bin!("kb"))
                .args(args)
                .env("KB_CONFIG_DIR", dir.join("config"))
                .env("KB_DATA_DIR", dir.join("data"))
                .env_remove("KB_LOG")
                .env("RUST_LOG", "warn")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .unwrap();
        let input = child.stdin.take();
        let output = child.stdout.take().unwrap();
        let mut errors = child.stderr.take().unwrap();
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = stderr.clone();
        let stderr_reader = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = errors.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        let (tx, replies) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        let mut peer = Self {
            child,
            input,
            replies,
            reader: Some(reader),
            stderr,
            stderr_reader: Some(stderr_reader),
            id: 0,
        };
        peer.send("server/discover", json!({}));
        let ready = peer.replies.recv_timeout(Duration::from_secs(180));
        assert!(
            ready.as_ref().is_ok_and(|r| r["result"].is_object()),
            "successful CLI readiness: {ready:?}; stderr: {}",
            peer.stderr.lock().unwrap()
        );
        peer
    }
    fn send(&mut self, method: &str, params: Value) -> u64 {
        self.id += 1;
        writeln!(
            self.input.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params})
        )
        .unwrap();
        self.id
    }
    fn send_notification(&mut self, method: &str, params: Value) {
        writeln!(
            self.input.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","method":method,"params":params})
        )
        .unwrap();
    }
    fn next(&mut self) -> Value {
        self.replies
            .recv_timeout(Duration::from_secs(60))
            .expect("bounded CLI reply")
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.request_with_timeout(method, params, Duration::from_secs(60))
    }
    fn request_with_timeout(&mut self, method: &str, params: Value, timeout: Duration) -> Value {
        self.send(method, params);
        self.replies
            .recv_timeout(timeout)
            .expect("bounded CLI reply")
    }
    /// The whole `tools/call` result (structured content, `_meta`); a
    /// JSON-RPC error fails the test.
    fn call(&mut self, name: &str, arguments: Value) -> Value {
        let reply = self.request("tools/call", json!({"name":name,"arguments":arguments}));
        assert!(reply["result"].is_object(), "{name}: {reply}");
        reply["result"].clone()
    }
    /// A successful result's data, labelled with its server.
    fn ok(&mut self, name: &str, arguments: Value) -> Value {
        let server = arguments["server"].clone();
        let reply = self.call(name, arguments);
        assert_eq!(reply["isError"], false, "{name}: {reply}");
        assert_eq!(reply["_meta"]["kb/server"], server, "{name}");
        reply["structuredContent"]["data"].clone()
    }
    fn tools(&mut self) -> Vec<Value> {
        self.request("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn close(mut self) -> String {
        self.input.take();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < until, "bounded EOF");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Every byte the process wrote, not just what was read so far: the
        // test owner holds the pipe until its tree is drained.
        self.child.drain().expect("peer tree drainage");
        self.stderr_reader.take().unwrap().join().unwrap();
        self.stderr.lock().unwrap().clone()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.input.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.child.drain().expect("peer tree drainage");
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn with(arguments: Value, server: &str) -> Value {
    let mut arguments = arguments;
    arguments["server"] = json!(server);
    arguments
}
fn row<'a>(tools: &'a [Value], name: &str) -> &'a Value {
    tools.iter().find(|t| t["name"] == name).unwrap()
}
fn calls(server: &Server) -> Vec<Value> {
    server
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|r| body(&r.wire))
        .filter(|b| b["method"] == "tools/call")
        .collect()
}
/// Every request a fixture server saw carried exactly its own token.
fn only_own_token(server: &Server, own: &str, other: &str) {
    let seen = server.seen.lock().unwrap();
    assert!(!seen.is_empty());
    for request in seen.iter() {
        let wire = request.wire.to_ascii_lowercase();
        assert!(wire.contains(&format!("authorization: bearer {}", token(own))));
        assert!(
            !wire.contains(&token(other)),
            "foreign token reached `{own}`"
        );
        // The `server` argument is never forwarded.
        assert!(
            body(&request.wire)["params"]["arguments"]
                .get("server")
                .is_none()
        );
    }
}

fn pair(a: Fake, b: Fake) -> (Server, Server, tempfile::TempDir) {
    let (a, b) = (a.serve(), b.serve());
    let dir = support::canonical_tempdir();
    save(dir.path(), &a.origin, "a");
    save(dir.path(), &b.origin, "b");
    (a, b, dir)
}
fn start(dir: &Path, a: &Server, b: &Server, extra: &[&str]) -> Peer {
    let (a, b) = (format!("a={}", a.origin), format!("b={}", b.origin));
    let mut args = vec![
        "mcp",
        "--server",
        &a,
        "--server",
        &b,
        "--allow-loopback-http",
    ];
    args.extend_from_slice(extra);
    Peer::start(dir, &args)
}

/// Wait until `server` has received `n` tool calls.
fn received(server: &Server, n: usize) {
    let until = Instant::now() + Duration::from_secs(30);
    while calls(server).len() < n {
        assert!(Instant::now() < until, "server never received {n} calls");
        std::thread::sleep(Duration::from_millis(10));
    }
}

const LABELS: [&str; 8] = ["a", "b", "c", "d", "e", "f", "g", "h"];

/// Each merged hit as (server, base, snippet).
fn hits(data: &Value) -> Vec<(String, String, String)> {
    data["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hit| {
            (
                hit["server"].as_str().unwrap().to_owned(),
                hit["knowledgeBaseId"].as_str().unwrap().to_owned(),
                hit["snippet"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}
fn hit(server: &str, kb: &str, rank: u64) -> (String, String, String) {
    (server.into(), kb.into(), format!("{kb} {rank}"))
}
/// Each base row as (server or "-", kbId, status, hitCount).
fn bases(data: &Value) -> Vec<(String, String, String, u64)> {
    data["knowledgeBases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (
                row["server"].as_str().unwrap_or("-").to_owned(),
                row["kbId"].as_str().unwrap().to_owned(),
                row["status"].as_str().unwrap().to_owned(),
                row["hitCount"].as_u64().unwrap(),
            )
        })
        .collect()
}
fn base(server: &str, kb: &str, status: &str, count: u64) -> (String, String, String, u64) {
    (server.into(), kb.into(), status.into(), count)
}

fn status(server: &str, status: &str, code: Option<&str>) -> (String, String, Value) {
    (server.into(), status.into(), json!(code))
}

mod credentials;
mod federated;
mod routing;
mod scope;
