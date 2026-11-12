//! Stateless MCP HTTP client against hand-rolled loopback fixtures.
//!
//! Every fixture is plain HTTP on 127.0.0.1, so each client opts into
//! [`TransportPolicy::AllowLoopbackHttp`]; the HTTPS-only default is covered by
//! the `origin` unit tests.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::task::Poll;
use std::time::{Duration, Instant};

use kb_client::types::{BasesGet, BasesList, ChangesApply, DocumentsCreate, DocumentsGet};
use kb_client::{
    CallControl, CancellationToken, ClientError, ClientOptions, Credential, Deadline, ErrorCode,
    KbError, MCP_PROFILE, McpClient, McpResource, ProtocolError, SecretToken, Tool,
    TransportPolicy,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CANARY: &str = "kb_pat_CANARY_7f3e9d2c4b1a";

const KB_A: &str = "kbaaaaaaaaaaaaaaaaaaaaaaaa";
const KB_B: &str = "kbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Index of a tool in the full local catalog.
#[allow(clippy::unwrap_used)] // Fixture construction.
fn row(tools: &Value, name: &str) -> usize {
    tools
        .as_array()
        .unwrap()
        .iter()
        .position(|tool| tool["name"] == name)
        .unwrap()
}

/// The server's list after `mode` changes the full catalog.
#[allow(clippy::unwrap_used)] // Fixture construction.
fn listed(mode: &str) -> Value {
    let full = kb_client::stdio::catalog().unwrap();
    let pick = |names: &[&str]| -> Value {
        Value::Array(
            names
                .iter()
                .map(|name| full[row(&full, name)].clone())
                .collect(),
        )
    };
    let read = [
        "knowledge_bases_get",
        "knowledge_documents_list",
        "knowledge_documents_get",
        "knowledge_search",
        "knowledge_structured_search",
    ];
    let mut tools = full.clone();
    match mode {
        "full" => {}
        "subset" => tools = pick(&read),
        "single" => tools = pick(&["knowledge_sealed_resolve"]),
        "narrowed" => {
            tools = pick(&["knowledge_search", "knowledge_assets_import"]);
            tools[0]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A, KB_B]);
            tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A]);
            tools[1]["inputSchema"]["properties"]["source"]["properties"]["kbId"]["enum"] =
                json!([KB_B]);
        }
        "never-matching" => {
            // No qualifying KB left on the connection: `not: {}`, not an empty enum.
            tools = pick(&["knowledge_search", "knowledge_assets_import"]);
            tools[0]["inputSchema"]["properties"]["kbId"]["not"] = json!({});
            tools[1]["inputSchema"]["properties"]["kbId"]["not"] = json!({});
            tools[1]["inputSchema"]["properties"]["source"]["properties"]["kbId"]["not"] =
                json!({});
        }
        "not-nonempty" => {
            tools[1]["inputSchema"]["properties"]["kbId"]["not"] = json!({"type":"string"})
        }
        "not-and-enum" => {
            tools[1]["inputSchema"]["properties"]["kbId"]["not"] = json!({});
            tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A]);
        }
        "not-elsewhere" => tools[1]["inputSchema"]["not"] = json!({}),
        "description" => tools[0]["description"] = json!("Server wording."),
        "no-description" => {
            tools[0].as_object_mut().unwrap().remove("description");
        }
        "extra-fields" => {
            tools[0]["title"] = json!("ignored");
            tools[0]["annotations"] = json!({"readOnlyHint": false});
        }
        "empty" => tools = json!([]),
        "reordered" => tools.as_array_mut().unwrap().reverse(),
        "out-of-order-subset" => tools = pick(&["knowledge_search", "knowledge_documents_get"]),
        "duplicate" => {
            let first = tools[0].clone();
            tools.as_array_mut().unwrap().push(first);
        }
        "input" => tools[0]["inputSchema"] = json!({}),
        "output" => tools[0]["outputSchema"] = json!({}),
        "unknown" => tools[0]["name"] = json!("control/mint"),
        "bad-description" => tools[0]["description"] = json!(7),
        "enum-empty" => tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([]),
        "enum-pattern" => {
            tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A, "../etc"]);
        }
        "enum-type" => tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([7]),
        "enum-duplicate" => {
            tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A, KB_A]);
        }
        "enum-not-array" => tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!(KB_A),
        "enum-elsewhere" => {
            let index = row(&tools, "knowledge_documents_get");
            tools[index]["inputSchema"]["properties"]["path"]["enum"] = json!(["a.md"]);
        }
        "enum-root" => tools[1]["inputSchema"]["enum"] = json!([{}]),
        "enum-and-drift" => {
            tools[1]["inputSchema"]["properties"]["kbId"]["enum"] = json!([KB_A]);
            tools[1]["inputSchema"]["properties"]["kbId"]["maxLength"] = json!(26);
        }
        "enum-replaces-pattern" => {
            let node = &mut tools[1]["inputSchema"]["properties"]["kbId"];
            node.as_object_mut().unwrap().remove("pattern");
            node["enum"] = json!([KB_A]);
        }
        "enum-on-output" => {
            tools[1]["outputSchema"]["properties"]["data"]["properties"]["kbId"]["enum"] =
                json!([KB_A])
        }
        _ => unreachable!("unknown mode {mode}"),
    }
    tools
}

#[tokio::test]
async fn catalog_verification_accepts_ordered_subsets_and_narrowed_kb_ids_only() {
    for mode in [
        "full",
        "subset",
        "single",
        "narrowed",
        "never-matching",
        "description",
        "no-description",
        "extra-fields",
    ] {
        let tools = listed(mode);
        let reply = tools.clone();
        let server =
            mock(move |r, _| rpc_result(r, json!({"resultType":"complete","tools":reply}))).await;
        let advertised = server
            .client(CANARY)
            .verify_catalog(&fixture_control())
            .await
            .unwrap_or_else(|error| panic!("{mode}: {error}"));
        let names: Vec<&str> = advertised.names().iter().map(|n| n.as_str()).collect();
        let listed_names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, listed_names, "{mode}");
        let rows = advertised.tools();
        let full = kb_client::stdio::catalog().unwrap();
        for (index, (advertised_row, server_row)) in rows
            .as_array()
            .unwrap()
            .iter()
            .zip(tools.as_array().unwrap())
            .enumerate()
        {
            let local = &full[row(&full, listed_names[index])];
            // Server input schema (narrowed or not); pinned output and annotations.
            assert_eq!(
                advertised_row["inputSchema"], server_row["inputSchema"],
                "{mode}"
            );
            assert_eq!(
                advertised_row["outputSchema"], local["outputSchema"],
                "{mode}"
            );
            assert_eq!(
                advertised_row["annotations"], local["annotations"],
                "{mode}"
            );
            assert!(advertised_row.get("title").is_none(), "{mode}");
            let description = server_row
                .get("description")
                .unwrap_or(&local["description"]);
            assert_eq!(&advertised_row["description"], description, "{mode}");
        }
        if mode == "full" {
            assert_eq!(rows, full);
        }
    }
}

#[tokio::test]
async fn catalog_verification_rejects_every_other_drift() {
    for mode in [
        "empty",
        "reordered",
        "out-of-order-subset",
        "duplicate",
        "input",
        "output",
        "unknown",
        "bad-description",
        "enum-empty",
        "enum-pattern",
        "enum-type",
        "enum-duplicate",
        "enum-not-array",
        "enum-elsewhere",
        "enum-root",
        "enum-and-drift",
        "enum-replaces-pattern",
        "enum-on-output",
        "not-nonempty",
        "not-and-enum",
        "not-elsewhere",
    ] {
        let tools = listed(mode);
        let server =
            mock(move |r, _| rpc_result(r, json!({"resultType":"complete","tools":tools}))).await;
        let result = server
            .client(CANARY)
            .verify_catalog(&fixture_control())
            .await;
        assert_eq!(result, Err(ClientError::IncompatibleCatalog), "{mode}");
    }
}

#[tokio::test]
async fn discovery_reports_server_instructions_and_rejects_non_string_ones() {
    for (instructions, expected) in [
        (None, Ok(None)),
        (
            Some(json!("Knowledge bases: x")),
            Ok(Some("Knowledge bases: x".to_owned())),
        ),
        (Some(json!(["x"])), Err(ClientError::MalformedResponse)),
    ] {
        let reply = instructions.clone();
        let server = mock(move |r, _| {
            let mut result = json!({"resultType":"complete","supportedVersions":[MCP_PROFILE],"capabilities":{"tools":{}}});
            if let Some(text) = &reply {
                result["instructions"] = text.clone();
            }
            rpc_result(r, result)
        })
        .await;
        let discovered = server
            .client(CANARY)
            .discover(&fixture_control())
            .await
            .map(|d| d.instructions);
        assert_eq!(discovered, expected, "{instructions:?}");
    }
}

#[tokio::test]
async fn agent_forwarding_preserves_validated_warnings_errors_and_ciphertext() {
    use kb_client::{ToolName, stdio::tool_error};
    let result = tool_error(
        ErrorCode::Conflict,
        json!({"headSha":"0".repeat(40),"proposalNumber":1}),
    );
    let mut expected = result.clone();
    expected["resultType"] = json!("complete");
    let server = mock(move |r, _| {
        let mut result = result.clone();
        result["resultType"] = json!("complete");
        rpc_result(r, result)
    })
    .await;
    let reply = server
        .client(CANARY)
        .forward_tool(
            ToolName::KnowledgeDocumentsCreate,
            fixtures()["tools"]["knowledge_documents_create"]["validInput"].clone(),
            &fixture_control(),
        )
        .await
        .unwrap();
    assert_eq!(reply, expected);
    for name in ToolName::ALL {
        let corpus = fixtures();
        let row = &corpus["tools"][name.as_str()];
        let envelope = json!({"schemaVersion":"kb/1","data":row["validOutput"]});
        let result = json!({"resultType":"complete","isError":false,"structuredContent":envelope,"content":[{"type":"text","text":envelope.to_string()},{"type":"text","text":"Rebuild pending"}]});
        let expected = result.clone();
        let server = mock(move |r, _| rpc_result(r, result.clone())).await;
        let reply = server
            .client(CANARY)
            .forward_tool(*name, row["validInput"].clone(), &fixture_control())
            .await
            .unwrap();
        assert_eq!(reply, expected, "{name}");
    }
}

#[tokio::test]
async fn forwarding_rejects_malformed_output_and_inherits_deadline_and_cancel() {
    use kb_client::ToolName;
    let server = mock(|r, _| rpc_result(r,json!({"resultType":"complete","isError":false,"structuredContent":{"schemaVersion":"kb/1","data":{"items":[],"nextCursor":null}},"content":[{"type":"text","text":"{}"}]}))).await;
    assert!(
        server
            .client(CANARY)
            .forward_tool(ToolName::KnowledgeBasesList, json!({}), &fixture_control())
            .await
            .is_err()
    );
    let server = mock(|_, _| Reply::Hang).await;
    let client = server.client(CANARY);
    let control = CallControl::timeout(Duration::from_millis(100));
    assert_eq!(
        client
            .forward_tool(ToolName::KnowledgeBasesList, json!({}), &control)
            .await
            .unwrap_err(),
        ClientError::Kb(KbError::DeadlineExceeded)
    );
    server.wait_hangups(1).await;
    let control = CallControl::timeout(Duration::from_secs(10));
    let cancel = control.cancel.clone();
    let request = client.forward_tool(ToolName::KnowledgeBasesList, json!({}), &control);
    let cancellation = async {
        server.wait_stalled(2).await;
        cancel.cancel();
    };
    let (reply, ()) = tokio::join!(request, cancellation);
    assert_eq!(reply.unwrap_err(), ClientError::Kb(KbError::Cancelled));
    server.wait_hangups(2).await;
}

// ── Loopback fixture ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Captured {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }
    fn raw_text(&self) -> String {
        let mut text = format!("{} {}\n", self.method, self.path);
        for (k, v) in &self.headers {
            text.push_str(&format!("{k}: {v}\n"));
        }
        text.push_str(&String::from_utf8_lossy(&self.body));
        text
    }
}

enum Reply {
    /// Full raw HTTP response bytes.
    Raw(Vec<u8>),
    /// Raw bytes, then close the connection.
    Close(Vec<u8>),
    /// Headers only, then stall until the peer hangs up.
    StallBody(Vec<u8>),
    /// Never answer; wait for the peer to hang up.
    Hang,
    /// Answer after a delay (a late response).
    Late(Duration, Vec<u8>),
}

type Handler = Arc<dyn Fn(&Captured, usize) -> Reply + Send + Sync>;

struct Mock {
    base: String,
    captured: Arc<Mutex<Vec<Captured>>>,
    hangups: Arc<AtomicUsize>,
    stalled: Arc<AtomicUsize>,
}

impl Mock {
    fn requests(&self) -> Vec<Captured> {
        self.captured.lock().expect("test fixture").clone()
    }
    fn resource(&self) -> McpResource {
        McpResource::parse(&self.base, TransportPolicy::AllowLoopbackHttp).expect("test fixture")
    }
    fn client(&self, token: &str) -> McpClient {
        let resource = self.resource();
        let credential = Credential::new(resource.clone(), SecretToken::new(token.to_owned()));
        McpClient::new(resource, credential, ClientOptions::default()).expect("test fixture")
    }
    async fn wait_count(&self, count: &AtomicUsize, n: usize) {
        let start = Instant::now();
        while count.load(Ordering::SeqCst) < n {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "fixture event never arrived"
            );
            // Keep virtual time frozen while real socket readiness is polled.
            tokio::task::yield_now().await;
        }
    }
    async fn wait_hangups(&self, n: usize) {
        self.wait_count(&self.hangups, n).await;
    }
    async fn wait_stalled(&self, n: usize) {
        self.wait_count(&self.stalled, n).await;
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<Captured> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let method = start.next()?.to_owned();
    let path = start.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Captured {
        method,
        path,
        headers,
        body,
    })
}

async fn wait_eof(stream: &mut TcpStream) {
    let mut sink = [0u8; 1024];
    while let Ok(n) = stream.read(&mut sink).await {
        if n == 0 {
            break;
        }
    }
}

async fn mock(handler: impl Fn(&Captured, usize) -> Reply + Send + Sync + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test fixture");
    let port = listener.local_addr().expect("test fixture").port();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let hangups = Arc::new(AtomicUsize::new(0));
    let stalled = Arc::new(AtomicUsize::new(0));
    let handler: Handler = Arc::new(handler);
    let (cap, hang, ready) = (captured.clone(), hangups.clone(), stalled.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let (cap, hang, ready, handler) =
                (cap.clone(), hang.clone(), ready.clone(), handler.clone());
            tokio::spawn(async move {
                while let Some(request) = read_request(&mut stream).await {
                    let index = {
                        let mut all = cap.lock().expect("test fixture");
                        all.push(request.clone());
                        all.len() - 1
                    };
                    match handler(&request, index) {
                        Reply::Raw(bytes) => {
                            if stream.write_all(&bytes).await.is_err() {
                                return;
                            }
                        }
                        Reply::Close(bytes) => {
                            let _ = stream.write_all(&bytes).await;
                            return;
                        }
                        Reply::StallBody(head) => {
                            stream.write_all(&head).await.expect("test fixture");
                            ready.fetch_add(1, Ordering::SeqCst);
                            wait_eof(&mut stream).await;
                            hang.fetch_add(1, Ordering::SeqCst);
                            return;
                        }
                        Reply::Hang => {
                            ready.fetch_add(1, Ordering::SeqCst);
                            wait_eof(&mut stream).await;
                            hang.fetch_add(1, Ordering::SeqCst);
                            return;
                        }
                        Reply::Late(delay, bytes) => {
                            ready.fetch_add(1, Ordering::SeqCst);
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {
                                    let _ = stream.write_all(&bytes).await;
                                }
                                _ = wait_eof(&mut stream) => {
                                    hang.fetch_add(1, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    Mock {
        base: format!("http://127.0.0.1:{port}"),
        captured,
        hangups,
        stalled,
    }
}

fn http(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn json_http(status: u16, body: &Value) -> Vec<u8> {
    http(
        status,
        &[("content-type", "application/json")],
        body.to_string().as_bytes(),
    )
}

fn request_id(request: &Captured) -> Value {
    request.json()["id"].clone()
}

fn rpc_result(request: &Captured, result: Value) -> Reply {
    Reply::Raw(json_http(
        200,
        &json!({"jsonrpc": "2.0", "id": request_id(request), "result": result}),
    ))
}

fn call_result(structured: Value, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": structured.to_string()}],
        "structuredContent": structured,
        "isError": is_error,
        "resultType": "complete",
    })
}

fn success(data: Value) -> Value {
    call_result(json!({"schemaVersion": "kb/1", "data": data}), false)
}

fn tool_error(code: &str, message: &str, retryable: bool) -> Value {
    call_result(
        json!({"schemaVersion": "kb/1", "error": {
            "code": code, "message": message, "retryable": retryable, "details": {}
        }}),
        true,
    )
}

fn fixtures() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("test fixture"))
        .expect("test fixture")
}

fn valid<T: Tool>(side: &str) -> Value {
    fixtures()["tools"][T::NAME.as_str()][side].clone()
}

fn input<T: Tool>() -> T::Input {
    serde_json::from_value(valid::<T>("validInput")).expect("test fixture")
}

// Protocol/transport fixtures assert results, not five-second host latency.
// This test-owned hang guard includes real socket I/O and blocking-pool admission
// on a loaded host. Deadline tests below supply their own exact controls.
const FIXTURE_IO_BUDGET: Duration = Duration::from_secs(120);

fn fixture_control() -> CallControl {
    CallControl::timeout(FIXTURE_IO_BUDGET)
}

fn assert_no_canary(error: &ClientError) {
    assert!(!format!("{error}").contains(CANARY));
    assert!(!format!("{error:?}").contains(CANARY));
}

// ── Envelope and headers ─────────────────────────────────────────────────────

#[tokio::test]
async fn tools_call_sends_exact_profile_headers_and_envelope() {
    let output = valid::<BasesList>("validOutput");
    let server = mock(move |r, _| rpc_result(r, success(output.clone()))).await;
    let client = server.client(CANARY);

    let page = client
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .expect("test fixture");
    assert_eq!(
        serde_json::to_value(page).expect("test fixture"),
        valid::<BasesList>("validOutput")
    );

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let r = &requests[0];
    assert_eq!(r.method, "POST");
    assert_eq!(r.path, "/mcp");
    assert_eq!(r.header("content-type"), Some("application/json"));
    assert_eq!(r.header("accept"), Some("application/json"));
    assert_eq!(r.header("mcp-protocol-version"), Some(MCP_PROFILE));
    assert_eq!(r.header("mcp-method"), Some("tools/call"));
    assert_eq!(r.header("mcp-name"), Some("knowledge_bases_list"));
    assert_eq!(
        r.header("authorization"),
        Some(format!("Bearer {CANARY}").as_str())
    );
    assert_eq!(r.header("cookie"), None);
    assert_eq!(r.header("mcp-session-id"), None);

    let body = r.json();
    let object = body.as_object().expect("test fixture");
    assert_eq!(object.len(), 4, "{body}");
    assert_eq!(body["jsonrpc"], "2.0");
    assert!(body["id"].as_u64().is_some());
    assert_eq!(body["method"], "tools/call");
    let params = body["params"].as_object().expect("test fixture");
    assert_eq!(params.len(), 3, "{body}");
    assert_eq!(params["name"], "knowledge_bases_list");
    assert_eq!(params["arguments"], valid::<BasesList>("validInput"));
    let meta = params["_meta"].as_object().expect("test fixture");
    assert_eq!(meta.len(), 3);
    assert_eq!(meta["io.modelcontextprotocol/protocolVersion"], MCP_PROFILE);
    assert_eq!(
        meta["io.modelcontextprotocol/clientCapabilities"],
        json!({})
    );
    let info = meta["io.modelcontextprotocol/clientInfo"]
        .as_object()
        .expect("test fixture");
    assert!(info["name"].is_string() && info["version"].is_string());
}

#[tokio::test]
async fn each_call_uses_a_fresh_bounded_json_rpc_id() {
    let output = valid::<BasesList>("validOutput");
    let server = mock(move |r, _| rpc_result(r, success(output.clone()))).await;
    let client = server.client(CANARY);
    for _ in 0..3 {
        client
            .call::<BasesList>(&input::<BasesList>(), &fixture_control())
            .await
            .expect("test fixture");
    }
    let ids: Vec<u64> = server
        .requests()
        .iter()
        .map(|r| request_id(r).as_u64().expect("test fixture"))
        .collect();
    assert_eq!(ids.len(), 3);
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    assert!(ids.iter().all(|id| *id <= 9_007_199_254_740_991));
}

#[tokio::test]
async fn discover_sends_server_discover_and_requires_the_pinned_profile() {
    let server = mock(|r, _| {
        rpc_result(
            r,
            json!({
                "supportedVersions": [MCP_PROFILE],
                "capabilities": {"tools": {"listChanged": true}},
                "resultType": "complete",
                "_meta": {"io.modelcontextprotocol/serverInfo": {"name": "kb", "version": "1"}},
            }),
        )
    })
    .await;
    let discovery = server
        .client(CANARY)
        .discover(&fixture_control())
        .await
        .expect("test fixture");
    assert_eq!(discovery.server_name, "kb");
    let r = &server.requests()[0];
    assert_eq!(r.header("mcp-method"), Some("server/discover"));
    assert_eq!(r.header("mcp-name"), None);
    assert_eq!(r.json()["method"], "server/discover");
    assert_eq!(
        r.json()["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
        MCP_PROFILE
    );
}

#[tokio::test]
async fn legacy_or_foreign_profiles_are_rejected_clearly() {
    // A server that only speaks an older revision.
    let old = mock(|r, _| {
        rpc_result(
            r,
            json!({"supportedVersions": ["2025-11-25"], "capabilities": {"tools": {}},
                   "resultType": "complete"}),
        )
    })
    .await;
    let e = old
        .client(CANARY)
        .discover(&fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::UnsupportedProfile);

    // A 2025-era server answers the modern probe with method-not-found.
    let legacy = mock(|r, _| {
        Reply::Raw(json_http(
            404,
            &json!({"jsonrpc": "2.0", "id": request_id(r),
                    "error": {"code": -32601, "message": "Method not found"}}),
        ))
    })
    .await;
    let e = legacy
        .client(CANARY)
        .discover(&fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::UnsupportedProfile);

    // The SDK's unsupported-protocol-version ladder error.
    let refused = mock(|r, _| {
        Reply::Raw(json_http(
            400,
            &json!({"jsonrpc": "2.0", "id": request_id(r),
                    "error": {"code": -32022, "message": "Unsupported protocol version"}}),
        ))
    })
    .await;
    let e = refused
        .client(CANARY)
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::UnsupportedProfile);

    // SSE framing and session ids belong to profiles this client never speaks.
    let sse = mock(|_, _| {
        Reply::Raw(http(
            200,
            &[("content-type", "text/event-stream")],
            b"data: {}\n\n",
        ))
    })
    .await;
    let e = sse
        .client(CANARY)
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::UnsupportedProfile);

    let output = valid::<BasesList>("validOutput");
    let session = mock(move |r, _| {
        let body =
            json!({"jsonrpc": "2.0", "id": request_id(r), "result": success(output.clone())});
        Reply::Raw(http(
            200,
            &[
                ("content-type", "application/json"),
                ("mcp-session-id", "abc"),
            ],
            body.to_string().as_bytes(),
        ))
    })
    .await;
    let e = session
        .client(CANARY)
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::UnsupportedProfile);
}

#[tokio::test]
async fn list_tools_returns_catalog_names_and_rejects_unknown_ones() {
    let server = mock(|r, index| {
        let tools = if index == 0 {
            json!([{"name": "knowledge_bases_list", "inputSchema": {"type": "object"}},
                   {"name": "knowledge_search", "inputSchema": {"type": "object"}}])
        } else {
            json!([{"name": "shell_exec", "inputSchema": {"type": "object"}}])
        };
        rpc_result(r, json!({"tools": tools, "resultType": "complete"}))
    })
    .await;
    let client = server.client(CANARY);
    let names = client
        .list_tools(&fixture_control())
        .await
        .expect("test fixture");
    assert_eq!(
        names,
        vec![
            kb_client::ToolName::KnowledgeBasesList,
            kb_client::ToolName::KnowledgeSearch
        ]
    );
    assert_eq!(
        server.requests()[0].header("mcp-method"),
        Some("tools/list")
    );
    let e = client.list_tools(&fixture_control()).await.unwrap_err();
    assert_eq!(
        e,
        ClientError::Kb(KbError::Protocol(ProtocolError::UnknownTool))
    );
}

// ── Status and error mapping ─────────────────────────────────────────────────

#[tokio::test]
async fn http_auth_rejections_are_distinct_from_domain_errors() {
    let server = mock(|r, index| match index {
        0 => Reply::Raw(json_http(401, &json!({"error": "UNAUTHORIZED"}))),
        1 => Reply::Raw(json_http(403, &json!({"error": "FORBIDDEN"}))),
        2 => rpc_result(r, tool_error("FORBIDDEN", "Forbidden", false)),
        3 => rpc_result(r, tool_error("NOT_FOUND", "Not found", false)),
        4 => Reply::Raw(json_http(503, &json!({"error": "STORAGE_UNAVAILABLE"}))),
        _ => Reply::Raw(http(500, &[], b"")),
    })
    .await;
    let client = server.client(CANARY);
    let mut errors = Vec::new();
    for _ in 0..6 {
        let e = client
            .call::<BasesGet>(&input::<BasesGet>(), &fixture_control())
            .await
            .unwrap_err();
        assert_no_canary(&e);
        errors.push(e);
    }
    assert_eq!(errors[0], ClientError::Unauthorized);
    assert_eq!(errors[1], ClientError::Forbidden);
    match &errors[2] {
        ClientError::Kb(KbError::Tool(t)) => assert_eq!(t.code(), ErrorCode::Forbidden),
        other => panic!("{other:?}"),
    }
    match &errors[3] {
        ClientError::Kb(KbError::Tool(t)) => assert_eq!(t.code(), ErrorCode::NotFound),
        other => panic!("{other:?}"),
    }
    assert_eq!(errors[4], ClientError::HttpStatus(503));
    assert!(errors[4].retryable());
    assert_eq!(errors[5], ClientError::HttpStatus(500));
    assert!(!errors[0].retryable() && !errors[1].retryable());
}

#[tokio::test]
async fn in_band_json_rpc_errors_map_to_rpc_codes_without_server_text() {
    let server = mock(|r, _| {
        Reply::Raw(json_http(
            200,
            &json!({"jsonrpc": "2.0", "id": request_id(r),
                    "error": {"code": -32602, "message": "Unknown tool SECRET-SERVER-TEXT"}}),
        ))
    })
    .await;
    let e = server
        .client(CANARY)
        .call::<BasesGet>(&input::<BasesGet>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::Rpc { code: -32602 });
    assert!(!format!("{e} {e:?}").contains("SECRET-SERVER-TEXT"));
}

#[tokio::test]
async fn malformed_truncated_and_mismatched_responses_fail_closed() {
    let output = valid::<BasesGet>("validOutput");
    let server = mock(move |r, index| {
        let id = request_id(r);
        let ok = success(output.clone());
        match index {
            0 => Reply::Raw(http(200, &[("content-type", "application/json")], b"{not json")),
            // Declared length longer than what is sent, then the peer closes.
            1 => Reply::Close(
                b"HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{\"jsonrpc\":"
                    .to_vec(),
            ),
            2 => Reply::Raw(json_http(200, &json!({"jsonrpc": "2.0", "id": 999_999, "result": ok}))),
            3 => {
                let mut result = ok;
                result.as_object_mut().expect("test fixture").remove("resultType");
                Reply::Raw(json_http(200, &json!({"jsonrpc": "2.0", "id": id, "result": result})))
            }
            4 => {
                let mut result = ok;
                result["content"][0]["text"] = json!("{\"schemaVersion\":\"kb/1\",\"data\":{}}");
                Reply::Raw(json_http(200, &json!({"jsonrpc": "2.0", "id": id, "result": result})))
            }
            5 => {
                let mut result = ok;
                result["isError"] = json!(true);
                Reply::Raw(json_http(200, &json!({"jsonrpc": "2.0", "id": id, "result": result})))
            }
            6 => Reply::Raw(json_http(200, &json!({"jsonrpc": "2.0", "id": id}))),
            _ => Reply::Raw(http(200, &[("content-type", "text/plain")], b"{}")),
        }
    })
    .await;
    let client = server.client(CANARY);
    let mut results = Vec::new();
    for _ in 0..8 {
        results.push(
            client
                .call::<BasesGet>(&input::<BasesGet>(), &fixture_control())
                .await
                .unwrap_err(),
        );
    }
    assert_eq!(results[0], ClientError::MalformedResponse);
    assert_eq!(results[1], ClientError::Transport);
    for (i, e) in results.iter().enumerate().skip(2) {
        assert_eq!(*e, ClientError::MalformedResponse, "case {i}");
    }
}

#[tokio::test]
async fn oversized_responses_are_cut_at_eight_mebibytes() {
    let server = mock(|_, index| {
        if index == 0 {
            // Declared too large: rejected from the header.
            let head = format!(
                "HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                8 * 1024 * 1024 + 1
            );
            Reply::StallBody(head.into_bytes())
        } else {
            // Undeclared (chunked) and too large: rejected while streaming.
            let mut bytes =
                b"HTTP/1.1 200 X\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n"
                    .to_vec();
            let piece = vec![b' '; 1024 * 1024];
            for _ in 0..9 {
                bytes.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
                bytes.extend_from_slice(&piece);
                bytes.extend_from_slice(b"\r\n");
            }
            bytes.extend_from_slice(b"0\r\n\r\n");
            Reply::Raw(bytes)
        }
    })
    .await;
    let client = server.client(CANARY);
    for _ in 0..2 {
        let e = client
            .call::<BasesGet>(&input::<BasesGet>(), &fixture_control())
            .await
            .unwrap_err();
        assert_eq!(e, ClientError::ResponseTooLarge);
    }
}

#[tokio::test]
async fn schema_is_enforced_before_and_after_transport() {
    let server = mock(|r, index| match index {
        0 => rpc_result(r, success(json!({"items": [], "nextCursor": 7}))),
        _ => rpc_result(
            r,
            call_result(json!({"schemaVersion": "kb/2", "data": {}}), false),
        ),
    })
    .await;
    let client = server.client(CANARY);

    // Before: an invalid input never reaches the wire.
    let mut bad = valid::<BasesList>("validInput");
    bad["limit"] = json!(51);
    let bad: <BasesList as Tool>::Input = serde_json::from_value(bad).expect("test fixture");
    let e = client
        .call::<BasesList>(&bad, &fixture_control())
        .await
        .unwrap_err();
    assert!(matches!(
        e,
        ClientError::Kb(KbError::Protocol(ProtocolError::InvalidInput(_)))
    ));
    assert_eq!(server.requests().len(), 0);

    // After: an output violating the contract is rejected.
    let e = client
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .unwrap_err();
    assert!(matches!(
        e,
        ClientError::Kb(KbError::Protocol(ProtocolError::InvalidOutput(_)))
    ));

    // Schema-version mismatch.
    let e = client
        .call::<BasesList>(&input::<BasesList>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(
        e,
        ClientError::Kb(KbError::Protocol(ProtocolError::SchemaVersionMismatch))
    );
}

#[tokio::test]
async fn requests_over_one_mebibyte_are_refused_before_sending() {
    let server = mock(|_, _| Reply::Hang).await;
    let mut value = valid::<ChangesApply>("validInput");
    let markdown = "a".repeat(128 * 1024);
    let changes: Vec<Value> = (0..8)
        .map(|i| json!({"op": "create", "path": format!("big-{i}.md"), "content": {"markdown": markdown}}))
        .collect();
    value["mode"] = json!("edit");
    value["changes"] = json!(changes);
    value.as_object_mut().expect("test fixture").remove("dream");
    value["sourceSessionIds"] = json!([]);
    let input: <ChangesApply as Tool>::Input = serde_json::from_value(value).expect("test fixture");
    let e = server
        .client(CANARY)
        .call::<ChangesApply>(&input, &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::RequestTooLarge);
    assert_eq!(server.requests().len(), 0);
}

// ── Deadlines, cancellation, late responses, retries ────────────────────────

// A host-defined Tool can have an expensive serializer/deserializer. Hold its
// real typed boundary until the caller settles, without slowing/mocking HTTP,
// JSON parsing, envelope validation or the production client. Only this test
// uses the gate; every wait has a fallback so broken clients cannot hang it.
struct CodecGate {
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}

static CODEC_GATE: Mutex<Option<CodecGate>> = Mutex::new(None);

fn hold_codec() {
    let gate = CODEC_GATE.lock().expect("test gate").take();
    if let Some(gate) = gate {
        gate.entered.send(()).expect("controller alive");
        gate.release
            .recv_timeout(Duration::from_secs(10))
            .expect("controller must release CPU work");
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(transparent)]
struct HeldInput(<DocumentsGet as Tool>::Input);

impl Serialize for HeldInput {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        hold_codec();
        self.0.serialize(serializer)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
struct HeldOutput(<DocumentsGet as Tool>::Output);

impl<'de> Deserialize<'de> for HeldOutput {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        hold_codec();
        <DocumentsGet as Tool>::Output::deserialize(deserializer).map(Self)
    }
}

struct HoldEncoding;
impl Tool for HoldEncoding {
    const NAME: kb_client::ToolName = DocumentsGet::NAME;
    type Input = HeldInput;
    type Output = <DocumentsGet as Tool>::Output;
}

struct HoldDecoding;
impl Tool for HoldDecoding {
    const NAME: kb_client::ToolName = DocumentsGet::NAME;
    type Input = <DocumentsGet as Tool>::Input;
    type Output = HeldOutput;
}

#[tokio::test]
async fn call_control_settles_during_encoding_and_final_valid_response_decoding() {
    let mut output = valid::<DocumentsGet>("validOutput");
    output["markdown"] = json!("a".repeat(1536 * 1024));
    let expected = kb_client::decode_output::<DocumentsGet>(output.clone()).unwrap();
    let reply = success(output);
    assert!(
        json_http(200, &json!({"jsonrpc":"2.0","id":1,"result":reply})).len() < 8 * 1024 * 1024
    );
    let server = mock(move |r, _| rpc_result(r, reply.clone())).await;
    let client = server.client(CANARY);
    let request = input::<DocumentsGet>();

    for encoding in [false, true] {
        for retry in [false, true] {
            for cancelled in [false, true] {
                let (entered_tx, entered_rx) = mpsc::channel();
                let (release_tx, release_rx) = mpsc::channel();
                let (settled_tx, settled_rx) = mpsc::channel();
                *CODEC_GATE.lock().unwrap() = Some(CodecGate {
                    entered: entered_tx,
                    release: release_rx,
                });
                let control = CallControl::timeout(Duration::from_secs(3));
                let cancel = control.cancel.clone();
                let remaining = control.deadline.remaining();
                let controller = std::thread::spawn(move || {
                    entered_rx
                        .recv_timeout(Duration::from_secs(10))
                        .expect("real codec reached");
                    if cancelled {
                        cancel.cancel();
                    }
                    // Broken synchronous decoding blocks the runtime here.
                    // Release on settlement, or on a bounded fallback; the
                    // assertion distinguishes those without a latency race.
                    let settled_while_held = settled_rx
                        .recv_timeout(remaining + Duration::from_secs(2))
                        .is_ok();
                    release_tx.send(()).unwrap();
                    settled_while_held
                });
                let before = server.requests().len();
                let result = if encoding {
                    let held = HeldInput(request.clone());
                    if retry {
                        client
                            .call_with_retry::<HoldEncoding>(&held, &control, 3)
                            .await
                    } else {
                        client.call::<HoldEncoding>(&held, &control).await
                    }
                } else {
                    let result = if retry {
                        client
                            .call_with_retry::<HoldDecoding>(&request, &control, 3)
                            .await
                    } else {
                        client.call::<HoldDecoding>(&request, &control).await
                    };
                    result.map(|output| output.0)
                };
                // Send even on success so historical failures get assertions
                // after cleanup, rather than stranding a worker in its gate.
                let _ = settled_tx.send(());
                assert!(
                    controller.join().unwrap(),
                    "caller blocked on codec (encoding={encoding}, retry={retry}, cancelled={cancelled})"
                );
                if encoding {
                    assert_eq!(
                        server.requests().len(),
                        before,
                        "abandoned encoding dispatched"
                    );
                }
                let error = result.unwrap_err();
                assert_eq!(
                    error,
                    ClientError::Kb(if cancelled {
                        KbError::Cancelled
                    } else {
                        KbError::DeadlineExceeded
                    })
                );
                // The abandoned job owns its taken gate and cannot affect a
                // successor, which must accept the same large valid data.
                let actual = client
                    .call::<DocumentsGet>(&request, &fixture_control())
                    .await
                    .unwrap();
                assert_eq!(actual, expected);
                if !encoding {
                    assert_eq!(
                        server.requests().len(),
                        before + 2,
                        "abandoned result retried"
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn all_public_entries_reject_abandoned_calls_before_dispatch() {
    let server = mock(|_, _| Reply::Hang).await;
    let client = server.client(CANARY);
    for cancelled in [false, true] {
        let control = if cancelled {
            let ctl = fixture_control();
            ctl.cancel.cancel();
            ctl
        } else {
            CallControl::new(Deadline::at(Instant::now()), CancellationToken::new())
        };
        let expected = ClientError::Kb(if cancelled {
            KbError::Cancelled
        } else {
            KbError::DeadlineExceeded
        });
        assert_eq!(client.discover(&control).await.unwrap_err(), expected);
        assert_eq!(client.list_tools(&control).await.unwrap_err(), expected);
        assert_eq!(client.verify_catalog(&control).await.unwrap_err(), expected);
        assert_eq!(
            client
                .forward_tool(
                    kb_client::ToolName::KnowledgeDocumentsGet,
                    fixtures()["tools"]["knowledge_documents_get"]["validInput"].clone(),
                    &control
                )
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(
            client
                .call::<DocumentsGet>(&input::<DocumentsGet>(), &control)
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(
            client
                .call_with_retry::<DocumentsGet>(&input::<DocumentsGet>(), &control, 3)
                .await
                .unwrap_err(),
            expected
        );
    }
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn explicit_proxy_is_a_trusted_intermediary_for_development_http() {
    let proxy = mock(|r, _| rpc_result(r, json!({"resultType":"complete", "tools":[]}))).await;
    let resource =
        McpResource::parse("http://127.0.0.1:9/mcp", TransportPolicy::AllowLoopbackHttp).unwrap();
    let credential = Credential::new(resource.clone(), SecretToken::new(CANARY.into()));
    let client = McpClient::new_with_proxy(
        resource,
        credential,
        ClientOptions::default(),
        reqwest::Proxy::all(&proxy.base).unwrap(),
    )
    .unwrap();
    assert!(
        client
            .list_tools(&fixture_control())
            .await
            .unwrap()
            .is_empty()
    );
    let requests = proxy.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "http://127.0.0.1:9/mcp");
    assert_eq!(
        requests[0].header("authorization"),
        Some(format!("Bearer {CANARY}").as_str())
    );
}

#[tokio::test]
async fn already_elapsed_deadline_never_starts_an_exchange() {
    let server = mock(|_, _| Reply::Hang).await;
    let client = server.client(CANARY);
    let request = input::<BasesGet>();
    let control = CallControl::new(Deadline::at(Instant::now()), CancellationToken::new());
    let error = client
        .call::<BasesGet>(&request, &control)
        .await
        .unwrap_err();
    assert_eq!(error, ClientError::Kb(KbError::DeadlineExceeded));
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn deadline_elapses_while_waiting_for_headers_or_body() {
    let server = mock(|_, index| {
        if index == 0 {
            Reply::Hang
        } else {
            Reply::StallBody(
                b"HTTP/1.1 200 X\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"
                    .to_vec(),
            )
        }
    })
    .await;
    let client = server.client(CANARY);
    // Build the on-disk fixture and initialize the schema evaluator before the
    // 200 ms I/O deadline. An already-expired call need not open a connection,
    // so it cannot establish the transport hangup this test is measuring.
    let request = input::<BasesGet>();
    kb_client::encode_input::<BasesGet>(&request).expect("test fixture");
    tokio::time::pause();
    for n in 1..=2 {
        // Exercise the same 200ms timer after real socket readiness, without
        // charging fixture scheduling against the product deadline.
        let at =
            tokio::time::Instant::now().into_std().max(Instant::now()) + Duration::from_millis(200);
        let control = CallControl::new(Deadline::at(at), CancellationToken::new());
        let call = client.call::<BasesGet>(&request, &control);
        tokio::pin!(call);
        tokio::select! {
            biased;
            result = &mut call => panic!("exchange finished before fixture stalled: {result:?}"),
            () = server.wait_stalled(n) => {}
        }
        assert_eq!(server.requests().len(), n);
        assert_eq!(server.hangups.load(Ordering::SeqCst), n - 1);
        // A missing timer cannot finish at this deadline.
        tokio::time::advance(at.saturating_duration_since(tokio::time::Instant::now().into_std()))
            .await;
        // Tokio timers have millisecond granularity. Poll once after the
        // next tick instead of awaiting (which could hide a missing timer).
        tokio::time::advance(Duration::from_millis(1)).await;
        let outcome = std::future::poll_fn(|cx| Poll::Ready(call.as_mut().poll(cx))).await;
        assert_eq!(
            outcome,
            Poll::Ready(Err(ClientError::Kb(KbError::DeadlineExceeded)))
        );
        server.wait_hangups(n).await;
    }
}

#[tokio::test]
async fn cancellation_aborts_the_exchange_and_discards_the_late_response() {
    let output = valid::<BasesGet>("validOutput");
    let server = mock(move |r, index| {
        let id = request_id(r);
        let body = json!({"jsonrpc": "2.0", "id": id, "result": success(output.clone())});
        if index == 0 {
            Reply::Late(Duration::from_millis(400), json_http(200, &body))
        } else {
            Reply::Raw(json_http(200, &body))
        }
    })
    .await;
    let client = server.client(CANARY);
    let request = input::<BasesGet>();
    let cancel = CancellationToken::new();
    let control = CallControl::new(Deadline::after(Duration::from_secs(5)), cancel.clone());
    tokio::time::pause();
    let call = client.call::<BasesGet>(&request, &control);
    tokio::pin!(call);
    tokio::select! {
        biased;
        result = &mut call => panic!("exchange finished before fixture stalled: {result:?}"),
        () = server.wait_stalled(1) => {}
    }
    cancel.cancel();
    // Cancellation must finish without any timer advance or server response.
    let outcome = std::future::poll_fn(|cx| Poll::Ready(call.as_mut().poll(cx))).await;
    assert_eq!(
        outcome,
        Poll::Ready(Err(ClientError::Kb(KbError::Cancelled)))
    );
    server.wait_hangups(1).await;

    // Move past the abandoned answer, then check the next exchange gets its
    // own response. No wall-clock sleep or late-answer timing race is needed.
    tokio::time::advance(Duration::from_millis(500)).await;
    // Real I/O must run with the clock resumed; a paused runtime would
    // auto-advance the next call to its deadline while waiting for the socket.
    tokio::time::resume();
    let out = client
        .call::<BasesGet>(&request, &fixture_control())
        .await
        .expect("test fixture");
    assert_eq!(
        serde_json::to_value(out).expect("test fixture"),
        valid::<BasesGet>("validOutput")
    );

    // A pre-cancelled call never touches the wire.
    let before = server.requests().len();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let control = CallControl::new(Deadline::after(Duration::from_secs(5)), cancelled);
    let e = client
        .call::<BasesGet>(&input::<BasesGet>(), &control)
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::Kb(KbError::Cancelled));
    assert_eq!(server.requests().len(), before);
}

#[tokio::test]
async fn retries_resend_the_same_mutation_key_and_stop_on_permanent_errors() {
    let output = valid::<DocumentsCreate>("validOutput");
    let server = mock(move |r, index| match index {
        0 => rpc_result(
            r,
            tool_error("STORAGE_UNAVAILABLE", "Storage unavailable", true),
        ),
        1 => Reply::Raw(json_http(503, &json!({"error": "STORAGE_UNAVAILABLE"}))),
        2 => rpc_result(r, success(output.clone())),
        _ => rpc_result(r, tool_error("CONFLICT", "Conflict", false)),
    })
    .await;
    let client = server.client(CANARY);
    let mutation = input::<DocumentsCreate>();
    client
        .call_with_retry::<DocumentsCreate>(&mutation, &fixture_control(), 5)
        .await
        .expect("test fixture");
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    let args: Vec<Value> = requests
        .iter()
        .map(|r| r.json()["params"]["arguments"].clone())
        .collect();
    assert!(args.iter().all(|a| *a == args[0]));
    assert_eq!(
        args[0]["idempotencyKey"],
        valid::<DocumentsCreate>("validInput")["idempotencyKey"]
    );
    let ids: Vec<Value> = requests.iter().map(request_id).collect();
    assert!(ids[0] != ids[1] && ids[1] != ids[2]);

    // Permanent domain errors are returned after one attempt.
    let e = client
        .call_with_retry::<DocumentsCreate>(&mutation, &fixture_control(), 5)
        .await
        .unwrap_err();
    assert!(matches!(e, ClientError::Kb(KbError::Tool(ref t)) if t.code() == ErrorCode::Conflict));
    assert_eq!(server.requests().len(), 4);
}

// ── Origin binding ───────────────────────────────────────────────────────────

#[tokio::test]
async fn credentials_never_cross_origins_or_follow_redirects() {
    let b = mock(|_, _| Reply::Raw(json_http(200, &json!({})))).await;
    let b_base = b.base.clone();
    let a = mock(move |_, _| Reply::Raw(http(307, &[("location", &format!("{b_base}/mcp"))], b"")))
        .await;

    // 30x from A is an error; B sees nothing.
    let e = a
        .client(CANARY)
        .call::<DocumentsGet>(&input::<DocumentsGet>(), &fixture_control())
        .await
        .unwrap_err();
    assert_eq!(e, ClientError::Redirected);
    assert_no_canary(&e);
    assert_eq!(a.requests().len(), 1);
    assert_eq!(b.requests().len(), 0);

    // `--server B` with a credential stored for A: refused before any I/O.
    let credential = Credential::new(a.resource(), SecretToken::new(CANARY.to_owned()));
    let e = McpClient::new(b.resource(), credential, ClientOptions::default()).unwrap_err();
    assert_eq!(e, ClientError::CredentialMismatch);
    assert_no_canary(&e);
    assert_eq!(b.requests().len(), 0);

    // Equivalent spellings of the same resource are the same binding.
    let spelled =
        |s: &str| McpResource::parse(s, TransportPolicy::AllowLoopbackHttp).expect("test fixture");
    assert_eq!(
        spelled("http://LOCALHOST:9/"),
        spelled("http://localhost:9/mcp")
    );
    assert_eq!(spelled(&format!("{}/", a.base)), a.resource());

    // Separate clients only ever present their own origin's credential.
    let other = "kb_pat_OTHER_ORIGIN_TOKEN";
    let _ = b
        .client(other)
        .call::<DocumentsGet>(&input::<DocumentsGet>(), &fixture_control())
        .await;
    for r in b.requests() {
        assert!(!r.raw_text().contains(CANARY));
    }
    for r in a.requests() {
        assert!(!r.raw_text().contains(other));
    }

    // Debug views of the binding never carry the secret.
    let client = a.client(CANARY);
    assert!(!format!("{client:?}").contains(CANARY));
    let credential = Credential::new(a.resource(), SecretToken::new(CANARY.to_owned()));
    assert!(!format!("{credential:?}").contains(CANARY));
}

#[test]
fn plain_http_needs_the_explicit_loopback_opt_in() {
    assert!(McpResource::parse("http://127.0.0.1:9/mcp", TransportPolicy::HttpsOnly).is_err());
    assert!(
        McpResource::parse(
            "http://kb.example.test/mcp",
            TransportPolicy::AllowLoopbackHttp
        )
        .is_err()
    );
    assert!(
        McpResource::parse("http://localhost:9/mcp", TransportPolicy::AllowLoopbackHttp).is_ok()
    );
}

#[tokio::test]
async fn raw_integral_output_is_accepted_at_the_http_decoder() {
    let mut output = valid::<BasesGet>("validOutput");
    output["index"]["dimensions"] = json!(3.0);
    let server = mock(move |r, _| {
        let mut result = success(output.clone());
        let mut mirrored = result["structuredContent"].clone();
        mirrored["data"]["index"]["dimensions"] = json!(3);
        result["content"][0]["text"] = json!(mirrored.to_string());
        // JSON-RPC numeric IDs also compare by value, not lexical spelling.
        let id = request_id(r).as_u64().unwrap() as f64;
        Reply::Raw(json_http(
            200,
            &json!({"jsonrpc":"2.0", "id":id, "result":result}),
        ))
    })
    .await;
    let out = server
        .client(CANARY)
        .call::<BasesGet>(&input::<BasesGet>(), &fixture_control())
        .await
        .unwrap();
    assert_eq!(
        kb_client::encode_output::<BasesGet>(&out).unwrap()["index"]["dimensions"],
        3
    );
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn unsafe_error_details_are_permanent_protocol_failures_without_retry() {
    for (code, field) in [
        (ErrorCode::Conflict, "proposalNumber"),
        (ErrorCode::RateLimited, "retryAfterSeconds"),
    ] {
        for wire in ["-9223372036854775808", "9007199254740992.0", "1.5"] {
            let n: Value = serde_json::from_str(wire).unwrap();
            let mut details = json!({});
            details[field] = n;
            if code == ErrorCode::Conflict {
                details["headSha"] = json!("0".repeat(40));
            }
            let server = mock(move |r, _| rpc_result(r, call_result(json!({
                "schemaVersion":"kb/1", "error": {"code":code.as_str(), "message":code.message(),
                    "retryable":code.retryable(), "details":details}
            }), true))).await;
            let err = server
                .client(CANARY)
                .call_with_retry::<BasesList>(&input::<BasesList>(), &fixture_control(), 2)
                .await
                .unwrap_err();
            assert!(
                matches!(
                    err,
                    ClientError::Kb(KbError::Protocol(ProtocolError::MalformedEnvelope))
                ),
                "{code} {wire}: {err:?}"
            );
            assert!(!err.retryable());
            assert_eq!(server.requests().len(), 1, "malformed errors cannot retry");
        }
    }
}

#[test]
fn rejected_change_batches_drain_a_small_blocking_pool_after_cancellation() {
    // Flood beyond a deliberately small pool through the real client encoder;
    // drain the runtime as well as checking caller settlement. No held worker
    // or mocked schema can let a timeout hide continuing quadratic validation.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let output = valid::<BasesList>("validOutput");
        let server = mock(move |r, _| rpc_result(r, success(output.clone()))).await;
        let client = Arc::new(server.client(CANARY));
        let mut value = valid::<ChangesApply>("validInput");
        value["sourceSessionIds"] = json!(
            (0..10_000)
                .map(|n| format!("00000000-0000-4000-8000-{n:012x}"))
                .collect::<Vec<_>>()
        );
        let request: <ChangesApply as Tool>::Input = serde_json::from_value(value).unwrap();
        let mut jobs = Vec::new();
        for i in 0..16 {
            let client = client.clone();
            let input = request.clone();
            let control = CallControl::timeout(Duration::from_secs(10));
            let cancel = control.cancel.clone();
            let job =
                tokio::spawn(async move { client.call::<ChangesApply>(&input, &control).await });
            if i % 2 == 0 {
                tokio::task::yield_now().await;
                cancel.cancel();
            }
            jobs.push(job);
        }
        for job in jobs {
            let error = job.await.unwrap().unwrap_err();
            assert!(
                matches!(
                    error,
                    ClientError::Kb(KbError::Cancelled)
                        | ClientError::Kb(KbError::Protocol(ProtocolError::InvalidInput(_)))
                ),
                "{error:?}"
            );
        }
        // Must still have a usable blocking worker and a legitimate request
        // after rejecting/cancelling more calls than the pool permits.
        tokio::time::timeout(Duration::from_secs(5), tokio::task::spawn_blocking(|| ()))
            .await
            .unwrap()
            .unwrap();
        client
            .call::<BasesList>(&input::<BasesList>(), &fixture_control())
            .await
            .unwrap();
        assert_eq!(
            server.requests().len(),
            1,
            "rejected mutations dispatch nothing"
        );
    });
    let drained = Instant::now();
    drop(runtime); // waits for every outstanding spawn_blocking job to exit
    assert!(
        drained.elapsed() < Duration::from_secs(5),
        "CPU validation remained running after cancellation"
    );
}

#[tokio::test]
async fn numerical_envelope_equivalence_still_rejects_different_values() {
    let mut output = valid::<BasesGet>("validOutput");
    output["index"]["dimensions"] = json!(3.0);
    let server = mock(move |r, _| {
        let mut result = success(output.clone());
        let mut mirrored = result["structuredContent"].clone();
        mirrored["data"]["index"]["dimensions"] = json!(4);
        result["content"][0]["text"] = json!(mirrored.to_string());
        rpc_result(r, result)
    })
    .await;
    let error = server
        .client(CANARY)
        .call_with_retry::<BasesGet>(&input::<BasesGet>(), &fixture_control(), 2)
        .await
        .unwrap_err();
    assert_eq!(error, ClientError::MalformedResponse);
    assert_eq!(server.requests().len(), 1);
}
