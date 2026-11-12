//! Shared loopback kb/1 tool server for the host adapter tests.
//!
//! Every request is recorded (tool name + arguments) so a test can assert the
//! exact call trace; the handler answers with a kb/1 `structuredContent`
//! envelope (`{"schemaVersion":"kb/1","data"|"error":...}`).

#![allow(
    dead_code,
    reason = "shared by several integration-test crates; each uses a subset"
)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_client::{
    CallControl, ClientOptions, Credential, McpClient, McpResource, SecretToken, TransportPolicy,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug)]
pub struct Call {
    pub tool: String,
    pub arguments: Value,
}

type Handler = Arc<dyn Fn(&str, &Value, usize) -> Value + Send + Sync>;

pub struct ToolServer {
    base: String,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl ToolServer {
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("test fixture").clone()
    }

    pub fn calls_to(&self, tool: &str) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| c.tool == tool)
            .collect()
    }

    pub fn resource(&self) -> McpResource {
        McpResource::parse(&self.base, TransportPolicy::AllowLoopbackHttp).expect("test fixture")
    }

    pub fn client(&self) -> McpClient {
        let resource = self.resource();
        let credential =
            Credential::new(resource.clone(), SecretToken::new("kb_pat_adapter".into()));
        McpClient::new(resource, credential, ClientOptions::default()).expect("test fixture")
    }
}

pub fn ctl() -> CallControl {
    CallControl::timeout(Duration::from_secs(10))
}

/// `{"schemaVersion":"kb/1","data":data}`.
pub fn ok(data: Value) -> Value {
    json!({"schemaVersion": "kb/1", "data": data})
}

/// Canonical kb/1 error envelope (fixed message/retryable from the client's
/// own error table, so the strict decoder accepts it).
pub fn err(code: kb_client::ErrorCode, details: Value) -> Value {
    json!({"schemaVersion": "kb/1", "error": {
        "code": code.as_str(),
        "message": code.message(),
        "retryable": code.retryable(),
        "details": details,
    }})
}

async fn read_request(stream: &mut TcpStream) -> Option<Vec<u8>> {
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
    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
    let length: usize = head
        .split("\r\n")
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim() == "content-length")
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(body)
}

pub async fn tool_server(
    handler: impl Fn(&str, &Value, usize) -> Value + Send + Sync + 'static,
) -> ToolServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test fixture");
    let port = listener.local_addr().expect("test fixture").port();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handler: Handler = Arc::new(handler);
    let recorded = calls.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let (recorded, handler) = (recorded.clone(), handler.clone());
            tokio::spawn(async move {
                while let Some(body) = read_request(&mut stream).await {
                    let request: Value = serde_json::from_slice(&body).expect("test fixture");
                    let tool = request["params"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned();
                    let arguments = request["params"]["arguments"].clone();
                    let index = {
                        let mut all = recorded.lock().expect("test fixture");
                        all.push(Call {
                            tool: tool.clone(),
                            arguments: arguments.clone(),
                        });
                        all.len() - 1
                    };
                    let structured = handler(&tool, &arguments, index);
                    let is_error = structured.get("error").is_some();
                    let result = json!({
                        "content": [{"type": "text", "text": structured.to_string()}],
                        "structuredContent": structured,
                        "isError": is_error,
                        "resultType": "complete",
                    });
                    let body = json!({"jsonrpc": "2.0", "id": request["id"], "result": result})
                        .to_string();
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    if stream.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    ToolServer {
        base: format!("http://127.0.0.1:{port}"),
        calls,
    }
}
