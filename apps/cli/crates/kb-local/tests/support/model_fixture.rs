//! Task 58 executable contract fixture: a real shared embedding worker
//! process (`embed-worker`) with fake inference, plus host parents.
use kb_local::{
    Store,
    embed_service::WORKER_ARG,
    qwen::{Embedding, ModelHost, ModelOutput, ModelRuntime},
};
use std::{io::Write, path::Path, path::PathBuf, time::Duration};

fn host(runtime: &str, models: &str) -> Result<ModelHost, Box<dyn std::error::Error>> {
    Ok(ModelHost::new(
        std::env::current_exe()?,
        PathBuf::from(runtime),
        PathBuf::from(models),
        Duration::from_secs(5),
    )?)
}

/// A parked fake job ends with its fixture: never leave a worker behind.
fn gone() {
    if std::env::current_dir().is_err() {
        std::process::exit(0);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let arg = |n: usize| args.get(n).cloned().ok_or("argument required");
    match args.get(1).map(String::as_str) {
        Some("download-parent") => {
            let cache = kb_local::model_download::ModelCache::new(PathBuf::from(arg(2)?))?;
            struct ParkedReader(bool);
            impl std::io::Read for ParkedReader {
                fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                    if !self.0 {
                        self.0 = true;
                        b.fill(42);
                        return Ok(b.len());
                    }
                    writeln!(std::io::stdout(), "ready")?;
                    std::io::stdout().flush()?;
                    loop {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
            let m = kb_local::qwen::descriptor("embeddinggemma-2-q8_0")?;
            cache.publish_reader(&m, ParkedReader(false))?;
            return Ok(());
        }
        Some("configure-parent") => {
            let store = Store::open(Path::new(&arg(2)?))?;
            let runtime = ModelRuntime::new(&store, host(&arg(3)?, &arg(4)?)?)?;
            runtime.configure(
                &store,
                &store.owner(),
                kb_local::qwen::ModelConfiguration {
                    model_id: "qwen3-embedding-0.6b-q8_0",
                    context_tokens: 1024,
                    acknowledge_memory_warning: true,
                    available_bytes: Some(2 << 30),
                    timeout: Duration::from_secs(900),
                },
            )?;
            return Ok(());
        }
        Some("parent") => {
            // A client process that embeds once, reports, then parks.
            let store = Store::open(Path::new(&arg(2)?))?;
            let runtime = ModelRuntime::new(&store, host(&arg(3)?, &arg(4)?)?)?;
            let e = runtime.embed(
                &store,
                &arg(5).unwrap_or_else(|_| "hello".into()),
                kb_local::qwen::Purpose::Query,
                Duration::from_secs(30),
            )?;
            writeln!(std::io::stdout(), "{}", e.pid)?;
            std::io::stdout().flush()?;
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        Some(WORKER_ARG) => {}
        _ => return Err("unknown fixture mode".into()),
    }
    let host = ModelHost::from_worker_args(std::env::current_exe()?, std::env::args_os().skip(2))?;
    if Path::new("model-test-worker-fail").exists() {
        return Err("worker start fault".into());
    }
    // Hooks are files in the worker's working directory (the runtime dir).
    kb_local::embed_service::serve(
        &host,
        Box::new(|m, n, cache, artifact, text, purpose, probe, measure| {
            let Some(artifact) = artifact else {
                // A slow release (a large model's memory going away).
                if Path::new("model-test-slow-release").exists() {
                    std::fs::write("model-test-releasing", b"releasing")
                        .map_err(kb_local::StoreError::Io)?;
                    while !Path::new("model-test-release-go").exists() {
                        gone();
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                std::fs::write("model-test-unloaded", b"unloaded")
                    .map_err(kb_local::StoreError::Io)?;
                return Err(kb_local::StoreError::IndexUnavailable);
            };
            // The production checksum of a load: hashes the whole (sparse,
            // correctly sized) file and fails while the job is running, as a
            // corrupt cached model does.
            if Path::new("model-test-verify-load").exists() {
                if let Ok(mut log) = std::fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open("model-test-verified")
                {
                    let _ = writeln!(log, "{}", std::process::id());
                }
                // Hash in full (the slow part of a real load) without the
                // private copy a real load of this unmarked seed would write.
                let _ = artifact;
                if cache.verify(m)? != kb_local::model_download::Verification::Verified {
                    return Err(kb_local::StoreError::IndexUnavailable);
                }
            }
            if Path::new("model-test-worker-crash").exists() {
                std::process::exit(9);
            }
            if measure {
                return Ok(ModelOutput::TokenCount(
                    text.len()
                        + m.document_prefix.len()
                        + usize::from(m.add_bos)
                        + usize::from(m.add_eos),
                ));
            }
            if probe {
                std::fs::write("model-test-probe-started", std::process::id().to_string())
                    .map_err(kb_local::StoreError::Io)?;
                if Path::new("model-test-probe-fail").exists() {
                    return Err(kb_local::StoreError::IndexUnavailable);
                }
                if Path::new("model-test-probe-park").exists() {
                    while !Path::new("model-test-probe-release").exists() {
                        gone();
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            } else if text.len() > n as usize && !text.chars().all(char::is_whitespace) {
                return Err(kb_local::StoreError::OperationAborted(
                    kb_client::ErrorCode::EmbeddingInputTooLong,
                ));
            }
            if text == "wait" {
                std::thread::sleep(Duration::from_millis(150));
            }
            if text == "failpark" {
                // A long request that FAILS (no lifetime extension).
                std::fs::write("model-test-started", b"admitted")
                    .map_err(kb_local::StoreError::Io)?;
                while !Path::new("model-test-release").exists() {
                    gone();
                    std::thread::sleep(Duration::from_millis(10));
                }
                return Err(kb_local::StoreError::IndexUnavailable);
            }
            if text == "park" {
                std::fs::write("model-test-started", b"admitted")
                    .map_err(kb_local::StoreError::Io)?;
                while !Path::new("model-test-release").exists() {
                    gone();
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            if let Ok(mut log) = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open("model-test-order")
            {
                let _ = writeln!(
                    log,
                    "{}:{text}",
                    match purpose {
                        kb_local::qwen::Purpose::Query => "q",
                        kb_local::qwen::Purpose::Document => "d",
                    }
                );
            }
            // One-hot on purpose: its 0.999-quantile int8 scale is 0, so builds
            // exercise the shared max fallback.
            let mut vector = vec![0.; m.dimensions];
            vector[0] = 1.;
            Ok(ModelOutput::Embedding(Embedding {
                vector,
                tokens: if probe {
                    vec![m.eos_token_id; n as usize]
                } else if text.starts_with("echo ") {
                    text.bytes().map(i32::from).collect()
                } else {
                    vec![m.bos_token_id, m.eos_token_id]
                },
                pid: std::process::id(),
                peak_bytes: None,
            }))
        }),
    )?;
    Ok(())
}
