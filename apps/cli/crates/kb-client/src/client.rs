//! Origin-bound, stateless MCP HTTP client.
//!
//! * One [`McpClient`] talks to exactly one [`McpResource`] and presents only
//!   the [`Credential`] minted for that resource; a mismatch is refused before
//!   any I/O. No redirect is ever followed (a 30x is an error), no cookie jar
//!   exists, and system proxies are ignored. An explicitly configured proxy
//!   is a trusted intermediary: it can see the bearer on development HTTP;
//!   HTTPS tunnels retain origin certificate validation and encrypt the POST.
//! * Every call is one POST bounded by 1 MiB out / 8 MiB in and by the
//!   caller's [`CallControl`], including encoding and final validation.
//!   Cancellation or the deadline drops pending I/O and discards late results.
//!   Pure CPU work already running on the blocking pool may finish privately.
//! * Inputs are schema-checked before transport, outputs after. HTTP 401/403
//!   are [`ClientError::Unauthorized`]/[`ClientError::Forbidden`], distinct from
//!   kb/1 domain errors ([`KbError::Tool`]).
//! * The client never retries on its own. [`McpClient::call_with_retry`]
//!   resends the byte-identical arguments, so a mutation keeps its caller-chosen
//!   idempotency key; no retry ever mints a new one.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::{StatusCode, Url};
use serde_json::{Map, Value};

use crate::error::{CancellationToken, Deadline, KbError};
use crate::origin::{Credential, McpResource, OriginError};
use crate::protocol::{
    self, ClientOptions, MCP_PROFILE, Method, RESPONSE_MAX_BYTES, ServerDiscovery,
};
use crate::types::{Tool, ToolName};

/// Every way a client call can fail. Display text is fixed per variant and
/// never includes a token, URL, request, or server-provided message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClientError {
    /// kb/1 domain error, contract violation, cancellation or deadline.
    Kb(KbError),
    Origin(OriginError),
    /// The credential was minted for a different resource.
    CredentialMismatch,
    /// The token cannot be sent as an HTTP header value.
    InvalidCredential,
    /// HTTP 401: missing, expired or revoked credential.
    Unauthorized,
    /// HTTP 403: credential admitted but refused (scope/origin).
    Forbidden,
    /// Any 30x; redirects are never followed.
    Redirected,
    /// Other non-success HTTP status without a JSON-RPC answer.
    HttpStatus(u16),
    RequestTooLarge,
    ResponseTooLarge,
    MalformedResponse,
    /// The server does not speak MCP 2026-07-28 stateless JSON (legacy
    /// handshake, SSE, sessions, or a different revision).
    UnsupportedProfile,
    /// The remote catalog is not exactly the pinned kb/1 data plane.
    IncompatibleCatalog,
    /// JSON-RPC error code from the server (its message is discarded).
    Rpc {
        code: i64,
    },
    /// Connection, TLS or read failure.
    Transport,
    RequestIdsExhausted,
}

impl ClientError {
    /// Whether resending the same request (same idempotency key) may succeed.
    pub fn retryable(&self) -> bool {
        match self {
            ClientError::Kb(error) => error.retryable(),
            ClientError::Transport => true,
            ClientError::HttpStatus(status) => matches!(status, 429 | 502 | 503 | 504),
            _ => false,
        }
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Kb(error) => error.fmt(f),
            ClientError::Origin(error) => error.fmt(f),
            ClientError::CredentialMismatch => {
                f.write_str("stored credential belongs to a different kb server")
            }
            ClientError::InvalidCredential => f.write_str("credential is not a valid bearer token"),
            ClientError::Unauthorized => f.write_str("kb server rejected the credential (401)"),
            ClientError::Forbidden => f.write_str("kb server refused the request (403)"),
            ClientError::Redirected => f.write_str("kb server answered with a redirect"),
            ClientError::HttpStatus(status) => write!(f, "kb server answered http {status}"),
            ClientError::RequestTooLarge => f.write_str("kb request exceeds 1 MiB"),
            ClientError::ResponseTooLarge => f.write_str("kb response exceeds 8 MiB"),
            ClientError::MalformedResponse => f.write_str("malformed mcp response"),
            ClientError::UnsupportedProfile => {
                write!(
                    f,
                    "kb server does not speak mcp {MCP_PROFILE} stateless json"
                )
            }
            ClientError::IncompatibleCatalog => f.write_str("incompatible kb/1 tool catalog"),
            ClientError::Rpc { code } => write!(f, "mcp error {code}"),
            ClientError::Transport => f.write_str("kb server connection failed"),
            ClientError::RequestIdsExhausted => f.write_str("mcp request ids exhausted"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<KbError> for ClientError {
    fn from(error: KbError) -> Self {
        ClientError::Kb(error)
    }
}

impl From<OriginError> for ClientError {
    fn from(error: OriginError) -> Self {
        ClientError::Origin(error)
    }
}

/// Deadline and cancellation for one call.
#[derive(Clone, Debug)]
pub struct CallControl {
    pub deadline: Deadline,
    pub cancel: CancellationToken,
}

impl CallControl {
    pub fn new(deadline: Deadline, cancel: CancellationToken) -> Self {
        CallControl { deadline, cancel }
    }

    /// A fresh, uncancelled call that expires after `timeout`.
    pub fn timeout(timeout: Duration) -> Self {
        Self::new(Deadline::after(timeout), CancellationToken::new())
    }

    fn check(&self) -> Result<(), ClientError> {
        self.cancel.check()?;
        self.deadline.check()?;
        Ok(())
    }

    /// The one admission/settlement boundary for every public async entry.
    async fn run<R>(
        &self,
        work: impl Future<Output = Result<R, ClientError>>,
    ) -> Result<R, ClientError> {
        self.check()?;
        let deadline = tokio::time::Instant::from_std(self.deadline.instant());
        let outcome = tokio::select! {
            biased;
            () = self.cancel.cancelled() => Err(KbError::Cancelled.into()),
            () = tokio::time::sleep_until(deadline) => Err(KbError::DeadlineExceeded.into()),
            result = work => result,
        };
        // Cancellation/expiry that raced completion wins, including errors.
        self.check()?;
        outcome
    }

    /// CPU-only owned work: never give this closure the HTTP client or token.
    /// Dropping its join handle discards the result; a queued job checks control
    /// before starting, and a running job checks again before publishing it.
    async fn cpu<R: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<R, ClientError> + Send + 'static,
    ) -> Result<R, ClientError> {
        self.check()?;
        let ctl = self.clone();
        tokio::task::spawn_blocking(move || {
            ctl.check()?;
            let result = work();
            ctl.check()?;
            result
        })
        .await
        .map_err(|_| ClientError::Transport)?
    }
}

/// A stateless MCP client bound to one resource and its credential.
pub struct McpClient {
    http: reqwest::Client,
    endpoint: Url,
    credential: Credential,
    options: ClientOptions,
    next_id: AtomicU64,
}

impl fmt::Debug for McpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClient")
            .field("credential", &self.credential)
            .finish_non_exhaustive()
    }
}

impl McpClient {
    /// Build a client for `resource`. `credential` must have been minted for
    /// exactly that resource (`--server` changes never forward a token).
    pub fn new(
        resource: McpResource,
        credential: Credential,
        options: ClientOptions,
    ) -> Result<Self, ClientError> {
        Self::build(resource, credential, options, None)
    }

    /// Explicit host-configured proxy; ambient proxy variables stay disabled.
    pub fn new_with_proxy(
        resource: McpResource,
        credential: Credential,
        options: ClientOptions,
        proxy: reqwest::Proxy,
    ) -> Result<Self, ClientError> {
        Self::build(resource, credential, options, Some(proxy))
    }

    fn build(
        resource: McpResource,
        credential: Credential,
        options: ClientOptions,
        proxy: Option<reqwest::Proxy>,
    ) -> Result<Self, ClientError> {
        if credential.resource() != &resource {
            return Err(ClientError::CredentialMismatch);
        }
        // reqwest (`rustls-no-provider`) reads the process-default provider;
        // an already-installed one is kept.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = Self::http_builder(&resource, proxy)
            .build()
            .map_err(|_| ClientError::Transport)?;
        Ok(McpClient {
            http,
            endpoint: resource.endpoint()?,
            credential,
            options,
            next_id: AtomicU64::new(1),
        })
    }

    fn http_builder(
        resource: &McpResource,
        proxy: Option<reqwest::Proxy>,
    ) -> reqwest::ClientBuilder {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .https_only(resource.is_https())
            .referer(false);
        if let Some(proxy) = proxy {
            builder = builder.proxy(proxy);
        }
        builder
    }

    pub fn resource(&self) -> &McpResource {
        self.credential.resource()
    }

    /// `server/discover`: confirm the server speaks this profile with tools.
    pub async fn discover(&self, ctl: &CallControl) -> Result<ServerDiscovery, ClientError> {
        ctl.run(self.exchange(Method::Discover, None, ctl, |result| {
            protocol::decode_discover(&result)
        }))
        .await
    }

    /// `tools/list`: the advertised catalog subset.
    pub async fn list_tools(&self, ctl: &CallControl) -> Result<Vec<ToolName>, ClientError> {
        ctl.run(self.exchange(Method::ToolsList, None, ctl, |result| {
            protocol::decode_tools_list(&result)
        }))
        .await
    }

    /// Fail explicitly unless the server lists a non-empty subset of the
    /// pinned catalog, in catalog order, with pinned schemas (inputs may only
    /// narrow `kbId` with an `enum`). Returns what a forwarder advertises;
    /// forwarders must call this before advertising anything.
    pub async fn verify_catalog(
        &self,
        ctl: &CallControl,
    ) -> Result<crate::stdio::Advertised, ClientError> {
        ctl.run(self.exchange(Method::ToolsList, None, ctl, |result| {
            protocol::verify_catalog(&result)
        }))
        .await
    }

    /// Agent forwarding only: schema-check a known tool and preserve the exact
    /// validated CallToolResult, including warnings/ciphertext/domain errors.
    /// One attempt; an unknown outcome never generates a replacement key.
    pub async fn forward_tool(
        &self,
        name: ToolName,
        arguments: Value,
        ctl: &CallControl,
    ) -> Result<Value, ClientError> {
        ctl.run(async {
            let arguments = ctl.cpu(move || Ok(name.check_input(arguments)?)).await?;
            self.exchange(
                Method::ToolsCall(name),
                Some(arguments),
                ctl,
                move |result| protocol::decode_forwarded_result(name, result),
            )
            .await
        })
        .await
    }

    /// `tools/call` for one typed catalog tool; one attempt.
    pub async fn call<T: Tool>(
        &self,
        input: &T::Input,
        ctl: &CallControl,
    ) -> Result<T::Output, ClientError> {
        ctl.run(async {
            let input = input.clone();
            let arguments = ctl
                .cpu(move || Ok(crate::encode_input::<T>(&input)?))
                .await?;
            self.call_encoded::<T>(arguments, ctl).await
        })
        .await
    }

    /// Like [`McpClient::call`], retrying retryable failures up to
    /// `max_attempts` total within the same deadline. Every attempt sends the
    /// identical arguments (same idempotency key); only the JSON-RPC id changes.
    pub async fn call_with_retry<T: Tool>(
        &self,
        input: &T::Input,
        ctl: &CallControl,
        max_attempts: u32,
    ) -> Result<T::Output, ClientError> {
        ctl.run(async {
            let input = input.clone();
            let arguments = ctl
                .cpu(move || Ok(crate::encode_input::<T>(&input)?))
                .await?;
            let mut attempt = 1;
            loop {
                ctl.check()?;
                let error = match self.call_encoded::<T>(arguments.clone(), ctl).await {
                    Ok(output) => return Ok(output),
                    Err(error) => error,
                };
                ctl.check()?;
                if attempt >= max_attempts || !error.retryable() {
                    return Err(error);
                }
                let backoff = retry_after(&error).min(ctl.deadline.remaining());
                tokio::time::sleep(backoff).await;
                attempt += 1;
            }
        })
        .await
    }

    async fn call_encoded<T: Tool>(
        &self,
        arguments: Value,
        ctl: &CallControl,
    ) -> Result<T::Output, ClientError> {
        self.exchange(
            Method::ToolsCall(T::NAME),
            Some(arguments),
            ctl,
            protocol::decode_tool_result::<T>
                as fn(Map<String, Value>) -> Result<T::Output, ClientError>,
        )
        .await
    }

    /// One request/response under the caller's deadline and cancellation.
    async fn exchange<R: Send + 'static>(
        &self,
        method: Method,
        arguments: Option<Value>,
        ctl: &CallControl,
        decode: impl FnOnce(Map<String, Value>) -> Result<R, ClientError> + Send + 'static,
    ) -> Result<R, ClientError> {
        ctl.check()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let options = self.options.clone();
        let body = ctl
            .cpu(move || protocol::encode_request(id, method, arguments, &options))
            .await?;
        // No request may be admitted after encoding used up its control.
        ctl.check()?;
        let (status, bytes) = self.post(method, body).await?;
        ctl.cpu(move || {
            let result = protocol::decode_response(id, &bytes);
            if status.is_success() {
                decode(result?)
            } else {
                // Ladder rejections may carry a JSON-RPC error; everything
                // else is a bare HTTP failure. Parsing is under the same guard.
                match result {
                    Err(error @ (ClientError::UnsupportedProfile | ClientError::Rpc { .. })) => {
                        Err(error)
                    }
                    _ => Err(ClientError::HttpStatus(status.as_u16())),
                }
            }
        })
        .await
    }

    async fn post(
        &self,
        method: Method,
        body: Vec<u8>,
    ) -> Result<(StatusCode, Vec<u8>), ClientError> {
        let mut bearer = HeaderValue::from_str(&format!(
            "Bearer {}",
            self.credential.token().expose_secret()
        ))
        .map_err(|_| ClientError::InvalidCredential)?;
        bearer.set_sensitive(true);
        let mut request = self
            .http
            .post(self.endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .header("mcp-protocol-version", MCP_PROFILE)
            .header("mcp-method", method.as_str())
            .header(AUTHORIZATION, bearer)
            .body(body);
        if let Some(name) = method.mcp_name() {
            request = request.header("mcp-name", name);
        }
        let mut response = request.send().await.map_err(|_| ClientError::Transport)?;
        let status = response.status();
        match status {
            StatusCode::UNAUTHORIZED => return Err(ClientError::Unauthorized),
            StatusCode::FORBIDDEN => return Err(ClientError::Forbidden),
            s if s.is_redirection() => return Err(ClientError::Redirected),
            _ => {}
        }
        if response.headers().contains_key("mcp-session-id") {
            return Err(ClientError::UnsupportedProfile);
        }
        let media = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(|v| v.trim().to_ascii_lowercase());
        let json = match media.as_deref() {
            Some("application/json") => true,
            Some("text/event-stream") => return Err(ClientError::UnsupportedProfile),
            _ => false,
        };
        if !json {
            return Err(if status.is_success() {
                ClientError::MalformedResponse
            } else {
                ClientError::HttpStatus(status.as_u16())
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > RESPONSE_MAX_BYTES as u64)
        {
            return Err(ClientError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ClientError::Transport)? {
            if bytes.len() + chunk.len() > RESPONSE_MAX_BYTES {
                return Err(ClientError::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((status, bytes))
    }
}

/// Wait before a retry: the server's `retryAfterSeconds` when given, else a
/// short fixed pause. The caller clamps it to the remaining deadline.
fn retry_after(error: &ClientError) -> Duration {
    if let ClientError::Kb(KbError::Tool(tool)) = error
        && let crate::error::ErrorDetails::RateLimited {
            retry_after_seconds,
        } = tool.details()
    {
        return Duration::from_secs(*retry_after_seconds);
    }
    Duration::from_millis(100)
}
