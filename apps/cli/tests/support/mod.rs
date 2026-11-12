//! CLI credential boundary fixture tests.
#![allow(clippy::unwrap_used)] // Test fixtures fail loudly.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub struct Request {
    pub wire: String,
    #[allow(dead_code)] // Only the login fixture checks polling intervals.
    pub at: Instant,
}
pub struct Server {
    pub origin: String,
    pub seen: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    pub fn new(
        reply: impl Fn(usize, &str, &str) -> (u16, String, String) + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = origin.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    assert!(bytes.len() < 32768);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let size = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")?
                                    .parse::<usize>()
                                    .ok()
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                let wire = String::from_utf8(bytes).unwrap();
                let at = Instant::now();
                let mut seen = requests.lock().unwrap();
                let index = seen.len();
                seen.push(Request {
                    wire: wire.clone(),
                    at,
                });
                drop(seen);
                let (status, headers, body) = reply(index, &wire, &base);
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            origin,
            seen,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let joined = self.thread.take().unwrap().join();
        // Preserve the original failed assertion instead of aborting the whole
        // test binary by panicking again during unwinding. On ordinary teardown
        // a fixture-thread failure still fails the test.
        if !thread::panicking() {
            joined.unwrap();
        }
    }
}

pub fn empty_credential_store(
    dir: &std::path::Path,
    resource: &kb_client::origin::McpResource,
) -> kb::state::CredentialStore {
    // Cold private-parent creation/ancestor durability has its own production
    // state tests. Prepare it outside the network/import watchdog to avoid
    // charging cold parent creation to the command's budget.
    // The command must still publish its real credential into an empty store.
    let store = kb::state::CredentialStore::new(dir.join("data/credentials"));
    assert!(store.load(resource).unwrap().is_none());
    let seed = kb_client::types::SecretToken::new("disposable-fixture-seed".into());
    store.save(resource, &seed).unwrap();
    assert!(store.remove_if_matches(resource, &seed).unwrap());
    assert!(store.load(resource).unwrap().is_none());
    store
}

pub fn cli(dir: &std::path::Path) -> assert_cmd::Command {
    let mut cmd = assert_cmd::Command::cargo_bin("kb").unwrap();
    cmd.env("KB_CONFIG_DIR", dir.join("config"))
        .env("KB_DATA_DIR", dir.join("data"))
        .env_remove("KB_LOG")
        .env("RUST_LOG", "debug");
    // This is an I/O/process watchdog, not a device polling deadline. The
    // production polling tests assert exact expiry/slow_down using paused time;
    // real HTTP cancellation still has its black-box stalled-response test.
    // Private credential fsync and child startup can consume the old 30s budget
    // under disk contention, including token imports that never poll at all.
    cmd.timeout(Duration::from_secs(120));
    cmd
}

pub fn remote(dir: &std::path::Path, command: &str, origin: &str) -> assert_cmd::Command {
    let mut cmd = cli(dir);
    cmd.args([command, "--server", origin, "--allow-loopback-http"]);
    cmd
}
