//! `kb login`: device approval or token import without putting secrets in argv.
use crate::{
    auth::{self, Poll, Remote, ServerArgs},
    config::Config,
    output,
    state::CredentialStore,
};
use anyhow::{Result, bail};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(flatten)]
    server: ServerArgs,
    /// Display name for the PAT created by device approval.
    #[arg(long, default_value = "kb CLI")]
    name: String,
    /// Import a token from piped stdin instead of starting device approval.
    #[arg(long, conflicts_with = "token_file")]
    token_stdin: bool,
    /// Import a token from a current-user-only file (no symlinks).
    #[arg(long)]
    token_file: Option<PathBuf>,
    /// Register a host-owned X25519 key from a current-user-only JSON file.
    /// The private key remains in that file for host-side sealed decryption.
    #[arg(long, conflicts_with_all = ["token_stdin", "token_file"])]
    recipient_key_file: Option<PathBuf>,
    /// Emit JSON status records; secrets are never included.
    #[arg(long)]
    json: bool,
}
pub fn run(args: &Args) -> Result<()> {
    let config = Config::load()?;
    let (resource, policy) = args.server.resolve_with_policy(&config)?;
    let store = CredentialStore::new(crate::paths::credentials_dir()?);
    let token = if args.token_stdin || args.token_file.is_some() {
        auth::import_token(args.token_file.as_ref())?
    } else {
        if args.name.is_empty()
            || args.name.chars().count() > 120
            || args.name.chars().any(char::is_control)
        {
            bail!("invalid device display name");
        }
        let remote = Remote::new(resource.clone(), config.proxy.as_deref())?;
        let recipient = args
            .recipient_key_file
            .as_deref()
            .map(auth::recipient_key)
            .transpose()?;
        crate::runtime()?.block_on(async {
            let start = remote.start(policy).await?;
            if let Some(key) = &recipient {
                remote.register_recipient(&start.device_code, key).await?;
                output::diagnostic(format!(
                    "recipient key {} ({})",
                    key.id(),
                    key.public_key_base64()
                ))?;
            }
            output::diagnostic(format!(
                "open {} and enter code {}",
                start.verification_uri_complete,
                display_user_code(&start.user_code)
            ))?;
            poll_device(start.expires_in, start.interval, || {
                remote.exchange(&start.device_code, &args.name)
            })
            .await
        })?
    };
    store.save(&resource, &token)?;
    if args.json {
        output::json(&LoginOutput {
            resource: resource.as_string(),
            logged_in: true,
        })
    } else {
        output::line(format!("logged in to {resource}"))
    }
}

/// The approval page shows an 8-character code as `ABCD-2345` and accepts it
/// with or without the hyphen; print the same grouped form here.
fn display_user_code(code: &str) -> String {
    if code.len() == 8 && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_owned()
    }
}

// The same polling/deadline boundary is exercised with virtual time in tests.
async fn poll_device<F, E>(
    expires_in: u64,
    interval: u64,
    mut exchange: E,
) -> Result<kb_client::types::SecretToken>
where
    F: std::future::Future<Output = Result<Poll>>,
    E: FnMut() -> F,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(expires_in);
    let mut interval = Duration::from_secs(interval);
    loop {
        // Waiting and HTTP both share the device's expiry bound.
        if tokio::time::Instant::now() + interval >= deadline {
            bail!("device authorization expired");
        }
        tokio::time::sleep(interval).await;
        // A descheduled interval can wake after expiry. Check again before
        // constructing/polling an HTTP exchange, including a ready future.
        if tokio::time::Instant::now() >= deadline {
            bail!("device authorization expired");
        }
        let outcome = tokio::time::timeout_at(deadline, exchange()).await;
        // Tokio may poll an already-ready exchange before its expired timer.
        // An authorization observed at/after expiry has an unknown outcome,
        // even when both futures become ready while this task is descheduled.
        if tokio::time::Instant::now() >= deadline {
            bail!("device exchange outcome is unknown; start a new login");
        }
        let poll = outcome.map_err(|_| {
            anyhow::anyhow!("device exchange outcome is unknown; start a new login")
        })??;
        match poll {
            Poll::Authorized(token) => return Ok(token),
            Poll::Pending => tracing::debug!("device authorization pending"),
            Poll::SlowDown => {
                interval += Duration::from_secs(5);
                tracing::debug!("device polling slowed down");
            }
        }
    }
}

#[derive(Serialize)]
struct LoginOutput {
    resource: String,
    logged_in: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::Poll as TaskPoll;

    /// Its own runtime: these tests pause the clock.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    async fn poll_once<F: std::future::Future>(
        mut future: std::pin::Pin<&mut F>,
    ) -> TaskPoll<F::Output> {
        tokio::task::yield_now().await;
        std::future::poll_fn(|cx| TaskPoll::Ready(future.as_mut().poll(cx))).await
    }

    #[test]
    fn user_code_is_grouped_like_the_approval_page() {
        assert_eq!(display_user_code("UJQRNNZL"), "UJQR-NNZL");
        assert_eq!(display_user_code("UJQR-NNZL"), "UJQR-NNZL");
        assert_eq!(display_user_code("ABC123"), "ABC123");
    }

    #[test]
    fn first_poll_waits_and_slow_down_adds_five_to_a_long_server_interval() {
        runtime().block_on(async {
            tokio::time::pause();
            let calls = AtomicUsize::new(0);
            let future = poll_device(60, 7, || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(if n == 0 {
                    Poll::SlowDown
                } else {
                    Poll::Authorized(kb_client::types::SecretToken::new("disposable-test".into()))
                }))
            });
            tokio::pin!(future);
            assert!(poll_once(future.as_mut()).await.is_pending());
            tokio::time::advance(Duration::from_millis(6999)).await;
            assert!(poll_once(future.as_mut()).await.is_pending());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            tokio::time::advance(Duration::from_millis(2)).await;
            assert!(poll_once(future.as_mut()).await.is_pending());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            tokio::time::advance(Duration::from_millis(11999)).await;
            assert!(poll_once(future.as_mut()).await.is_pending());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            tokio::time::advance(Duration::from_millis(2)).await;
            let TaskPoll::Ready(Ok(token)) = poll_once(future.as_mut()).await else {
                panic!("slow-down authorization did not finish");
            };
            assert_eq!(token.expose_secret(), "disposable-test");
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn a_ready_authorization_at_expiry_cannot_bypass_the_deadline() {
        runtime().block_on(async {
            tokio::time::pause();
            let future = poll_device(3, 1, || async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                Ok(Poll::Authorized(kb_client::types::SecretToken::new(
                    "disposable-late".into(),
                )))
            });
            tokio::pin!(future);
            assert!(poll_once(future.as_mut()).await.is_pending());
            tokio::time::advance(Duration::from_millis(1001)).await;
            assert!(poll_once(future.as_mut()).await.is_pending());
            tokio::time::advance(Duration::from_secs(3)).await;
            match poll_once(future.as_mut()).await {
                TaskPoll::Ready(result) => assert_eq!(
                    result.expect_err("late authorization").to_string(),
                    "device exchange outcome is unknown; start a new login"
                ),
                TaskPoll::Pending => panic!("expired authorization stayed pending"),
            }
        });
    }

    #[test]
    fn an_overslept_interval_never_starts_an_exchange_after_expiry() {
        runtime().block_on(async {
            tokio::time::pause();
            let calls = AtomicUsize::new(0);
            let future = poll_device(3, 1, || {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<Result<Poll>>()
            });
            tokio::pin!(future);
            assert!(poll_once(future.as_mut()).await.is_pending());
            tokio::time::advance(Duration::from_secs(5)).await;
            match poll_once(future.as_mut()).await {
                TaskPoll::Ready(result) => assert_eq!(
                    result.expect_err("expired interval").to_string(),
                    "device authorization expired"
                ),
                TaskPoll::Pending => panic!("expired interval stayed pending"),
            }
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn stalled_exchange_obeys_exact_device_deadline_and_drops_the_exchange() {
        runtime().block_on(async {
            tokio::time::pause();
            let calls = AtomicUsize::new(0);
            let dropped = Arc::new(AtomicUsize::new(0));
            struct Dropped(Arc<AtomicUsize>);
            impl Drop for Dropped {
                fn drop(&mut self) {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
            }
            let exchange = || {
                calls.fetch_add(1, Ordering::SeqCst);
                let held = Dropped(dropped.clone());
                async move {
                    let _held = held;
                    std::future::pending::<Result<Poll>>().await
                }
            };
            let mut login = std::pin::pin!(poll_device(3, 1, exchange));
            assert!(poll_once(login.as_mut()).await.is_pending());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            // Tokio timers have millisecond granularity; allow one timer tick.
            tokio::time::advance(Duration::from_millis(1001)).await;
            assert!(poll_once(login.as_mut()).await.is_pending());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            tokio::time::advance(Duration::from_millis(1998)).await;
            assert!(poll_once(login.as_mut()).await.is_pending());
            assert_eq!(dropped.load(Ordering::SeqCst), 0);
            tokio::time::advance(Duration::from_millis(2)).await;
            let TaskPoll::Ready(result) = poll_once(login.as_mut()).await else {
                panic!("device deadline did not cancel the exchange");
            };
            assert!(
                result
                    .expect_err("deadline must reject")
                    .to_string()
                    .contains("outcome is unknown")
            );
            assert_eq!(dropped.load(Ordering::SeqCst), 1);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn slow_down_is_cumulative_and_preserves_long_server_intervals() {
        for interval in [1, 7] {
            runtime().block_on(async {
                tokio::time::pause();
                let calls = AtomicUsize::new(0);
                let mut login = std::pin::pin!(poll_device(120, interval, || {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Ok(match n {
                        0 | 1 => Poll::SlowDown,
                        _ => Poll::Authorized(kb_client::types::SecretToken::new(
                            "disposable-test".into(),
                        )),
                    }))
                }));
                assert!(poll_once(login.as_mut()).await.is_pending());
                for n in 0..3 {
                    let wait = interval + 5 * n as u64;
                    tokio::time::advance(Duration::from_secs(wait - 1)).await;
                    assert!(poll_once(login.as_mut()).await.is_pending());
                    assert_eq!(calls.load(Ordering::SeqCst), n);
                    // Cross the exact interval with one Tokio timer tick.
                    tokio::time::advance(Duration::from_millis(1001)).await;
                    let outcome = poll_once(login.as_mut()).await;
                    assert_eq!(calls.load(Ordering::SeqCst), n + 1);
                    if n < 2 {
                        assert!(outcome.is_pending());
                    } else {
                        let TaskPoll::Ready(Ok(token)) = outcome else {
                            panic!("authorized exchange must finish at its interval");
                        };
                        assert_eq!(token.expose_secret(), "disposable-test");
                    }
                }
            });
        }
    }

    #[test]
    fn polling_preserves_success_pending_slow_down_and_no_exchange_at_expiry() {
        runtime().block_on(async {
            tokio::time::pause();
            let calls = AtomicUsize::new(0);
            let mut login = std::pin::pin!(poll_device(30, 1, || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(match n {
                    0 => Poll::Pending,
                    1 => Poll::SlowDown,
                    _ => Poll::Authorized(kb_client::types::SecretToken::new(
                        "disposable-test".into(),
                    )),
                }))
            }));
            assert!(poll_once(login.as_mut()).await.is_pending());
            for (delay, count) in [(1001, 1), (1001, 2), (5000, 2)] {
                tokio::time::advance(Duration::from_millis(delay)).await;
                assert!(poll_once(login.as_mut()).await.is_pending());
                assert_eq!(calls.load(Ordering::SeqCst), count);
            }
            tokio::time::advance(Duration::from_millis(1001)).await;
            let TaskPoll::Ready(Ok(token)) = poll_once(login.as_mut()).await else {
                panic!("authorized exchange must finish");
            };
            assert_eq!(token.expose_secret(), "disposable-test");
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            let result = poll_device(1, 2, || async {
                panic!("exchange after expiry");
            })
            .await;
            assert!(result.expect_err("expiry").to_string().contains("expired"));
        });
    }
}
