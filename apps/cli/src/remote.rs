//! Agent-only forwarding. Host sealed decryption and control APIs never enter
//! this path. One client/resource, one attempt, and the caller's operation key.
use crate::{auth::ServerArgs, config::Config, state::CredentialStore};
use kb_client::{
    CallControl, ClientError, ClientOptions, Credential, Deadline, ErrorCode, McpClient,
    stdio::{serve_until, tool_error},
};
use std::{sync::Arc, time::Duration};

pub fn run(server: &ServerArgs, config: &Config, read_only: bool) -> anyhow::Result<()> {
    let resource = server.resolve(config)?;
    let token = CredentialStore::new(crate::paths::credentials_dir()?)
        .load(&resource)?
        .ok_or_else(|| anyhow::anyhow!("no credential for this server; run `kb login`"))?;
    let credential = Credential::new(resource.clone(), token);
    let options = ClientOptions {
        name: "kb-cli".into(),
        ..ClientOptions::default()
    };
    let client = Arc::new(if let Some(proxy) = config.proxy.as_deref() {
        crate::auth::validate_proxy(proxy)?;
        McpClient::new_with_proxy(
            resource,
            credential,
            options,
            reqwest::Proxy::all(proxy).map_err(|_| anyhow::anyhow!("invalid configured proxy"))?,
        )?
    } else {
        McpClient::new(resource, credential, options)?
    });
    let runtime = crate::runtime()?;
    let handle = runtime.handle().clone();
    let result = runtime.block_on(async {
        let startup = CallControl::timeout(Duration::from_secs(10));
        let discovery = client.discover(&startup).await?;
        // Advertise exactly the server's validated list and instructions;
        // tools it did not list are refused before any forwarding.
        let advertised = client
            .verify_catalog(&startup)
            .await?
            .with_instructions(discovery.instructions);
        // R2-27: a read-only connection does not even list write tools.
        let advertised = if read_only {
            advertised.retain_read_only()
        } else {
            advertised
        };
        #[cfg(unix)]
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let shutdown = async {
            #[cfg(unix)]
            tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
        };
        serve_until(tokio::io::stdin(), tokio::io::stdout(), advertised, move |name, input, control| {
            if read_only && !name.read_only() {
                return tool_error(ErrorCode::Forbidden, serde_json::json!({}));
            }
            let call = CallControl::new(Deadline::at(control.until()), control.work_token());
            match handle.block_on(client.forward_tool(name, input, &call)) {
                Ok(result) => result,
                Err(error) => {
                    // No automatic retry: a dropped reply may follow a commit.
                    if !name.read_only() {
                        tracing::warn!("remote mutation outcome is unknown; retry with the same idempotency key");
                    }
                    tool_error(error_code(&error), serde_json::json!({}))
                }
            }
        }, shutdown).await?;
        Ok::<_, anyhow::Error>(())
    });
    // The stdio loop joins every handler before returning; Tokio's blocking
    // stdin thread may still await the peer and is closed by process exit
    // (the process runtime is never dropped).
    result
}

fn error_code(error: &ClientError) -> ErrorCode {
    match error {
        ClientError::Kb(error) => error.code(),
        ClientError::Unauthorized
        | ClientError::InvalidCredential
        | ClientError::Forbidden
        | ClientError::CredentialMismatch => ErrorCode::Forbidden,
        ClientError::Transport | ClientError::HttpStatus(502..=504) => {
            ErrorCode::StorageUnavailable
        }
        ClientError::HttpStatus(429) => ErrorCode::RateLimited,
        ClientError::RequestTooLarge | ClientError::ResponseTooLarge => ErrorCode::QuotaExceeded,
        _ => ErrorCode::Internal,
    }
}
