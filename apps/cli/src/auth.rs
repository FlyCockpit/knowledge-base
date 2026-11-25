//! Device wire adapter. No cookies, redirects, ambient proxy, body logging or
//! automatic retry: a lost exchange reply may already have consumed the code.
use anyhow::{Result, bail};
use kb_client::{
    authoring::AuthoringMode,
    mcp::origin::{McpResource, TransportPolicy},
    types::SecretToken,
};
use reqwest::{
    StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use serde::Deserialize;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zeroize::Zeroizing;

/// Defaults shared by oRPC's SimpleCsrfProtection handler and link plugins.
const ORPC_CSRF_HEADER: (&str, &str) = ("x-csrf-token", "orpc");

/// Existing host-owned private key file; never uploaded or logged. Keeping the
/// file lets the host use kb-client's recipient decryption after device login.
pub fn recipient_key(file: &Path) -> Result<kb_client::host::sealed::RecipientKey> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StoredKey {
        id: String,
        private_key: Zeroizing<[u8; 32]>,
    }
    let mut input = crate::state::open_user_private_file(file)?;
    let mut bytes = Zeroizing::new(Vec::new());
    Read::by_ref(&mut input)
        .take(4097)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        bail!("recipient key file is too large");
    }
    let stored: StoredKey = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid recipient key file"))?;
    let id = kb_client::types::Uuid::parse(&stored.id)
        .map_err(|_| anyhow::anyhow!("invalid recipient key id"))?;
    Ok(kb_client::host::sealed::RecipientKey::from_bytes(
        id,
        *stored.private_key,
    ))
}

/// `--write-mode <dream|edit|both>`: the three modes, listed in `--help`.
pub fn write_mode_parser() -> impl clap::builder::TypedValueParser<Value = AuthoringMode> {
    use clap::builder::TypedValueParser as _;
    clap::builder::PossibleValuesParser::new(["dream", "edit", "both"])
        .try_map(|mode: String| mode.parse::<AuthoringMode>())
}

#[derive(Debug, clap::Args)]
pub struct ServerArgs {
    /// Server origin or its /mcp resource, or the name of a configured server
    /// (`kb config add-server`); overrides config.
    #[arg(long, value_name = "URL|NAME")]
    pub server: Option<String>,
    /// Permit plain HTTP only for loopback development servers.
    #[arg(long)]
    pub allow_loopback_http: bool,
}
impl ServerArgs {
    pub fn resolve(&self, config: &crate::config::Config) -> Result<McpResource> {
        Ok(self.resolve_with_policy(config)?.0)
    }
    /// The resource and the transport policy it was admitted under. Plain
    /// HTTP needs `--allow-loopback-http` on this command, or the opt-in
    /// `kb config set-server --allow-loopback-http` remembered for exactly
    /// this origin (or `allow_loopback_http` on the named server's entry).
    pub fn resolve_with_policy(
        &self,
        config: &crate::config::Config,
    ) -> Result<(McpResource, TransportPolicy)> {
        let input = self
            .server
            .as_deref()
            .or(config.server.as_deref())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "server is not configured; use `--server` or `kb config set-server`"
                )
            })?;
        let selected = select(input, self.allow_loopback_http, config)?;
        Ok((selected.resource, selected.policy))
    }
}

/// One server a command addresses, resolved from `--server`/config.
#[derive(Debug, Clone)]
pub struct Selected {
    /// The configured name, or the `name` of `name=<url>`; `None` for a bare URL.
    pub name: Option<String>,
    pub resource: McpResource,
    pub policy: TransportPolicy,
    /// The named entry's `read_only`.
    pub read_only: bool,
    /// The named entry's `write_mode`.
    pub write_mode: Option<AuthoringMode>,
    /// The named entry's `search_all` (an unconfigured server takes part).
    pub search_all: bool,
}

/// Resolve one `--server` value: anything containing `://` is a URL
/// (optionally `name=<url>`), anything else names a `[servers.<name>]` entry.
/// The plain-HTTP opt-in of a named entry binds to that entry's own origin.
pub fn select(
    input: &str,
    allow_loopback_http: bool,
    config: &crate::config::Config,
) -> Result<Selected> {
    let (name, url, entry) = if input.contains("://") {
        match input.split_once('=') {
            Some((name, url)) if crate::config::is_server_name(name) && url.contains("://") => {
                (Some(name.to_owned()), url, None)
            }
            _ => (None, input, None),
        }
    } else {
        if !crate::config::is_server_name(input) {
            bail!("`--server` takes a server URL or a server name (1-32 of a-z, 0-9 and -)");
        }
        let entry = config.servers.get(input).ok_or_else(|| {
            anyhow::anyhow!(
                "no server named `{input}` is configured; add it with `kb config add-server {input} <url>`"
            )
        })?;
        (Some(input.to_owned()), entry.url.as_str(), Some(entry))
    };
    let candidate =
        McpResource::parse(url, TransportPolicy::AllowLoopbackHttp).map_err(origin_hint)?;
    let policy = if allow_loopback_http
        || entry.is_some_and(|entry| entry.allow_loopback_http)
        || config.loopback_http_opt_in.as_deref() == Some(candidate.origin())
    {
        TransportPolicy::AllowLoopbackHttp
    } else {
        TransportPolicy::HttpsOnly
    };
    Ok(Selected {
        name,
        resource: McpResource::parse(url, policy).map_err(origin_hint)?,
        policy,
        read_only: entry.is_some_and(|entry| entry.read_only),
        write_mode: entry.and_then(|entry| entry.write_mode),
        search_all: entry.is_none_or(|entry| entry.search_all),
    })
}

/// Name the flag when plain HTTP is refused.
fn origin_hint(error: kb_client::mcp::origin::OriginError) -> anyhow::Error {
    match error {
        kb_client::mcp::origin::OriginError::InsecureTransport => anyhow::anyhow!(
            "server url must use https; plain http is allowed only for a loopback development \
             server with `--allow-loopback-http` (or `kb config set-server <url> \
             --allow-loopback-http`, which remembers it for that server)"
        ),
        other => other.into(),
    }
}

pub struct Remote {
    pub resource: McpResource,
    http: reqwest::Client,
}
impl Remote {
    pub fn new(resource: McpResource, proxy: Option<&str>) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(10));
        if let Some(proxy) = proxy {
            crate::config::validate_proxy(proxy)?;
            builder = builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|_| anyhow::anyhow!("invalid configured proxy"))?,
            );
        }
        Ok(Self {
            resource,
            http: builder
                .build()
                .map_err(|_| anyhow::anyhow!("could not initialize secure HTTP client"))?,
        })
    }
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let request = self
            .http
            .post(format!("{}{path}", self.resource.origin()))
            .header("accept", "application/json");
        if path.starts_with("/rpc/") {
            request.header(ORPC_CSRF_HEADER.0, ORPC_CSRF_HEADER.1)
        } else {
            request
        }
    }
    /// Start device approval. `write_mode` (`kb login --write-mode`) is the
    /// most the approval may grant; sent only when given.
    pub async fn start(
        &self,
        policy: TransportPolicy,
        write_mode: Option<AuthoringMode>,
    ) -> Result<DeviceStart> {
        let mut body = serde_json::json!({"client_id":"kb-cli", "scope":"mcp:read mcp:write"});
        if let Some(mode) = write_mode {
            body["kb_write_mode"] = serde_json::json!(mode.as_str());
        }
        let body = serde_json::to_vec(&body)?;
        let (status, bytes) = read_response(
            self.post("/api/auth/device/code")
                .header("content-type", "application/json")
                .body(body),
        )
        .await?;
        if status != StatusCode::OK {
            bail!("device start failed (HTTP {})", status.as_u16());
        }
        let start: DeviceStart = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid device start response"))?;
        if start.device_code.is_empty()
            || start.device_code.len() > 512
            || start.interval == 0
            || start.interval > 600
            || start.expires_in == 0
            || start.expires_in > 600
            || start.user_code.len() > 16
            || start.user_code.is_empty()
            || !start
                .user_code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        {
            bail!("invalid device start response");
        }
        // The web control plane may live on another origin. Display only an
        // HTTPS (or explicit loopback) /device URL with this public user code.
        for uri in [&start.verification_uri, &start.verification_uri_complete] {
            let url = reqwest::Url::parse(uri)
                .map_err(|_| anyhow::anyhow!("invalid device verification URL"))?;
            McpResource::parse(&url.origin().ascii_serialization(), policy)?;
            if !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
                || !url.path().ends_with("/device")
                || url
                    .query_pairs()
                    .any(|(key, value)| key != "user_code" || value != start.user_code)
            {
                bail!("invalid device verification URL");
            }
        }
        Ok(start)
    }
    pub async fn exchange(&self, code: &str, name: &str) -> Result<Poll> {
        let body = Zeroizing::new(serde_json::to_vec(
            &serde_json::json!({"json":{"deviceCode":code,"name":name}}),
        )?);
        let (status, bytes) = read_response(
            self.post("/rpc/cliCredentials/exchangeDeviceCode")
                .header("content-type", "application/json")
                .body(body.to_vec()),
        )
        .await
        .map_err(|_| anyhow::anyhow!("device exchange outcome is unknown; start a new login"))?;
        if status == StatusCode::OK {
            let envelope: Envelope<Exchange> = serde_json::from_slice(&bytes).map_err(|_| {
                anyhow::anyhow!("invalid device exchange response; start a new login")
            })?;
            let result = envelope.json;
            if result.resource != self.resource.as_string() {
                bail!(
                    "device credential resource differs from requested server; start a new login"
                );
            }
            let token = parse_token(result.secret.as_bytes())?;
            return Ok(Poll::Authorized(token, result.authoring_mode));
        }
        if status == StatusCode::BAD_REQUEST
            && let Ok(envelope) = serde_json::from_slice::<Envelope<FlowError>>(&bytes)
            && envelope.json.code == "BAD_REQUEST"
        {
            return match envelope.json.data.error.as_str() {
                "authorization_pending" => Ok(Poll::Pending),
                "slow_down" => Ok(Poll::SlowDown),
                "access_denied" => Err(anyhow::anyhow!("device authorization denied")),
                "expired_token" => Err(anyhow::anyhow!("device authorization expired")),
                _ => Err(anyhow::anyhow!(
                    "device code is unavailable; start a new login"
                )),
            };
        }
        bail!(
            "device exchange failed (HTTP {}); start a new login",
            status.as_u16()
        )
    }
    pub async fn register_recipient(
        &self,
        code: &str,
        key: &kb_client::host::sealed::RecipientKey,
    ) -> Result<()> {
        let body = Zeroizing::new(serde_json::to_vec(&serde_json::json!({"json": {
            "deviceCode": code,
            "recipientKey": {"recipientKeyId": key.id().as_str(), "recipientPublicKey": key.public_key_base64()}
        }}))?);
        let (status, _) = read_response(
            self.post("/rpc/cliCredentials/registerDeviceRecipient")
                .header("content-type", "application/json")
                .body(body.to_vec()),
        )
        .await?;
        if status != StatusCode::OK {
            bail!(
                "device recipient registration failed (HTTP {})",
                status.as_u16()
            );
        }
        Ok(())
    }
    fn bearer(token: &SecretToken) -> Result<HeaderValue> {
        let mut header = HeaderValue::from_str(&format!("Bearer {}", token.expose_secret()))
            .map_err(|_| anyhow::anyhow!("invalid stored credential"))?;
        header.set_sensitive(true);
        Ok(header)
    }
    /// Revokes the presented PAT. Only the endpoint's own "credential ended"
    /// 401 (`{"error":"UNAUTHORIZED","credential":"ended"}`: unknown, revoked or
    /// expired, never admitted again) proves it is dead. Any other outcome is
    /// unknown, including a plain 401: a suspended owner (a ban that lifts) or
    /// something in front of the server.
    pub async fn revoke(&self, token: &SecretToken) -> Result<Revocation> {
        const RETRY: &str = "retry logout, or run `kb logout --local` to remove it locally";
        let unknown =
            || anyhow::anyhow!("remote revocation is unknown; local credential retained; {RETRY}");
        let header = Self::bearer(token)?;
        let mut response = self
            .post("/api/kb/token/revoke-self")
            .header(AUTHORIZATION, header)
            .send()
            .await
            .map_err(|_| unknown())?;
        let status = response.status();
        if status == StatusCode::NO_CONTENT {
            return Ok(Revocation::Revoked);
        }
        if status == StatusCode::UNAUTHORIZED {
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| unknown())? {
                if body.len() + chunk.len() > 1024 {
                    body.clear();
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            if is_credential_ended(&body) {
                return Ok(Revocation::AlreadyRevoked);
            }
        }
        bail!(
            "remote revocation is unknown (HTTP {}); local credential retained; {RETRY}",
            status.as_u16()
        )
    }
}
/// The revoke endpoint's refusal of a credential that ended (apps/server kb-token-routes).
fn is_credential_ended(body: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Refusal {
        error: String,
        credential: Option<String>,
    }
    serde_json::from_slice::<Refusal>(body).is_ok_and(|refusal| {
        refusal.error == "UNAUTHORIZED" && refusal.credential.as_deref() == Some("ended")
    })
}
/// Remote outcome of a self-revocation that proved the token is dead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revocation {
    Revoked,
    AlreadyRevoked,
}
async fn read_response(
    request: reqwest::RequestBuilder,
) -> Result<(StatusCode, Zeroizing<Vec<u8>>)> {
    let mut response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("auth request failed"))?;
    let status = response.status();
    if status.is_redirection() {
        bail!("auth server returned a redirect");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("auth response interrupted"))?
    {
        if bytes.len() + chunk.len() > 16384 {
            bail!("auth response too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}
#[derive(Clone, Copy)]
pub enum InputPolicy {
    Pat,
    Provider,
}
impl InputPolicy {
    fn limit(self) -> usize {
        match self {
            Self::Pat => 8192,
            Self::Provider => 16384,
        }
    }
}
pub fn import_token(file: Option<&PathBuf>) -> Result<SecretToken> {
    import_secret(file, InputPolicy::Pat)
}
pub fn import_secret(file: Option<&PathBuf>, policy: InputPolicy) -> Result<SecretToken> {
    let mut reader: Box<dyn Read> = if let Some(path) = file {
        Box::new(crate::state::open_user_private_file(path)?)
    } else {
        if std::io::stdin().is_terminal() {
            bail!("pipe the token to stdin; interactive token entry is disabled");
        }
        Box::new(std::io::stdin())
    };
    let mut bytes = Zeroizing::new(Vec::new());
    reader
        .by_ref()
        .take((policy.limit() + 3) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("could not read token input"))?;
    parse_secret(&bytes, policy)
}
fn parse_token(bytes: &[u8]) -> Result<SecretToken> {
    parse_secret(bytes, InputPolicy::Pat)
}
fn parse_secret(bytes: &[u8], policy: InputPolicy) -> Result<SecretToken> {
    if bytes.len() > policy.limit() + 2 {
        bail!("invalid token input");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| anyhow::anyhow!("invalid token input"))?;
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    if text.is_empty()
        || text.len() > policy.limit()
        || !text.bytes().all(|b| match policy {
            InputPolicy::Pat => b.is_ascii_alphanumeric() || b"._~+/-=".contains(&b),
            InputPolicy::Provider => (0x21..=0x7e).contains(&b),
        })
    {
        bail!("invalid token input");
    }
    Ok(SecretToken::new(text.to_owned()))
}
#[derive(Deserialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}
#[derive(Deserialize)]
struct Envelope<T> {
    json: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Exchange {
    #[serde(rename = "credentialId")]
    _credential_id: String,
    #[serde(rename = "userId")]
    _user_id: String,
    secret: Zeroizing<String>,
    #[serde(rename = "expiresAt")]
    _expires_at: String,
    resource: String,
    /// The approved write mode; `null` (or absent) for a read-only credential.
    #[serde(rename = "authoringMode", default)]
    authoring_mode: Option<AuthoringMode>,
}
#[derive(Deserialize)]
struct FlowError {
    code: String,
    data: FlowData,
}
#[derive(Deserialize)]
struct FlowData {
    error: String,
}
pub enum Poll {
    Pending,
    SlowDown,
    /// The credential and the write mode it was approved for.
    Authorized(SecretToken, Option<AuthoringMode>),
}

/// Exact bounded UTF8 for human sealed enrollment; unlike token import, no
/// whitespace trimming. Private no-follow files reuse the existing boundary.
pub fn import_sealed_literal(file: Option<&PathBuf>) -> Result<kb_local::sealed::Literal> {
    let mut reader: Box<dyn Read> = if let Some(path) = file {
        Box::new(crate::state::open_user_private_file(path)?)
    } else {
        if std::io::stdin().is_terminal() {
            bail!("pipe the sealed literal to stdin");
        }
        Box::new(std::io::stdin())
    };
    // Fixed backing storage: growing a plaintext Vec can leave old allocations.
    let mut bytes = Zeroizing::new(vec![0; 16385]);
    let mut used = 0;
    loop {
        let count = match reader.read(&mut bytes[used..]) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => bail!("could not read sealed input"),
        };
        used += count;
        if used > 16384 {
            bail!("the sealed value is larger than 16384 bytes");
        }
        if count == 0 {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes[..used])
        .map_err(|_| anyhow::anyhow!("the sealed value is not valid UTF-8"))?;
    Ok(kb_local::sealed::Literal::from_utf8(text.to_owned())?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn loopback_http_opt_in_is_remembered_for_that_origin_only() {
        use super::{ServerArgs, TransportPolicy};
        let config = crate::config::Config {
            server: Some("http://localhost:3100".into()),
            loopback_http_opt_in: Some("http://localhost:3100".into()),
            ..crate::config::Config::default()
        };
        let no_flag = |server: Option<&str>| ServerArgs {
            server: server.map(str::to_owned),
            allow_loopback_http: false,
        };
        let (resource, policy) = no_flag(None)
            .resolve_with_policy(&config)
            .expect("remembered");
        assert_eq!(resource.origin(), "http://localhost:3100");
        assert_eq!(policy, TransportPolicy::AllowLoopbackHttp);
        // The same origin passed explicitly is remembered too.
        assert!(
            no_flag(Some("http://localhost:3100/mcp"))
                .resolve(&config)
                .is_ok()
        );
        // Another loopback origin still needs the flag, and the error names it.
        let error = no_flag(Some("http://localhost:3101"))
            .resolve(&config)
            .expect_err("other origin");
        assert!(
            error.to_string().contains("--allow-loopback-http"),
            "{error}"
        );
        let flagged = ServerArgs {
            server: Some("http://localhost:3101".into()),
            allow_loopback_http: true,
        };
        assert!(flagged.resolve(&config).is_ok());
        // Without a remembered opt-in, the configured http server is refused.
        let plain = crate::config::Config {
            loopback_http_opt_in: None,
            ..config.clone()
        };
        assert!(no_flag(None).resolve(&plain).is_err());
        // https never depends on the opt-in.
        let (_, policy) = no_flag(Some("https://kb.example"))
            .resolve_with_policy(&plain)
            .expect("https");
        assert_eq!(policy, TransportPolicy::HttpsOnly);
    }
    #[test]
    fn recipient_import_preserves_the_host_key_and_rejects_malformed_or_public_files() {
        let directory = crate::state::canonical_tempdir();
        let path = directory.path().join("recipient.json");
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        std::fs::write(
            &path,
            serde_json::json!({"id": id, "private_key": vec![7; 32]}).to_string(),
        )
        .expect("fixture key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .expect("private mode");
        }
        // The Windows equivalent of mode 0600: the store's own owner-only DACL.
        #[cfg(windows)]
        crate::state::set_private(&path, false).expect("private ACL");
        let key = super::recipient_key(&path).expect("valid private key");
        let expected = kb_client::host::sealed::RecipientKey::from_bytes(
            kb_client::types::Uuid::parse(id).expect("fixture id"),
            [7; 32],
        );
        assert_eq!(key.public_key_base64(), expected.public_key_base64());
        assert_eq!(key.id(), expected.id());
        assert!(
            std::fs::read_to_string(&path)
                .expect("retained key")
                .contains(id)
        );
        std::fs::write(&path, "{malformed").expect("invalid fixture");
        assert!(super::recipient_key(&path).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
                .expect("public mode");
            assert!(super::recipient_key(&path).is_err());
        }
        // A valid key file left with the inherited (non-private) ACL.
        #[cfg(windows)]
        {
            let public = directory.path().join("public.json");
            std::fs::write(
                &public,
                serde_json::json!({"id": id, "private_key": vec![7; 32]}).to_string(),
            )
            .expect("public fixture key");
            assert!(super::recipient_key(&public).is_err());
        }
    }
    #[test]
    fn bearer_header_debug_is_redacted() {
        let token = kb_client::types::SecretToken::new("disposable-header-canary".into());
        let header = super::Remote::bearer(&token).expect("valid header");
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains("disposable-header-canary"));
    }
}
