//! Canonical server origins, the `/mcp` OAuth resource, KB attachment
//! locators, and origin-bound credentials.
//!
//! A credential is minted for exactly one resource (`<canonical-origin>/mcp`)
//! and the client refuses to present it anywhere else. Equivalent spellings
//! (`HTTPS://Host:443/`, `https://host/mcp`) canonicalize to one resource. A
//! locator's `#kb=<id>` fragment pins the KB for identity but is stripped for
//! transport and OAuth resource. Errors never echo the rejected input.

use std::fmt;
use std::net::IpAddr;

use reqwest::Url;

use crate::types::{KbId, SecretToken};

/// Path of the MCP endpoint and OAuth resource on every server.
pub const MCP_PATH: &str = "/mcp";

/// Which transports a resource may use. HTTPS is the default; plain HTTP is
/// an explicit development opt-in and only for loopback hosts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TransportPolicy {
    #[default]
    HttpsOnly,
    AllowLoopbackHttp,
}

/// Why a server URL or locator was rejected. Never carries the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginError {
    /// Not an absolute `http(s)` URL with a host.
    Invalid,
    /// Userinfo, query, or a path other than `/` or `/mcp`.
    NotAResource,
    /// `http://` without the loopback opt-in, or for a non-loopback host.
    InsecureTransport,
    /// Locator fragment is not exactly `kb=<id>` with a valid KB id.
    InvalidLocator,
}

impl fmt::Display for OriginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            OriginError::Invalid => "invalid server url",
            OriginError::NotAResource => "server url must be an origin or `<origin>/mcp`",
            OriginError::InsecureTransport => {
                "server url must use https (plain http only for loopback with the dev opt-in)"
            }
            OriginError::InvalidLocator => "invalid kb attachment locator",
        })
    }
}

impl std::error::Error for OriginError {}

/// The canonical `/mcp` resource of one server origin.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct McpResource {
    /// `scheme://host[:port]`, lowercase host, default port elided.
    origin: String,
}

impl McpResource {
    /// Parse a server URL (`--server`): an origin, optionally with `/` or
    /// `/mcp`. Fragments are rejected here; use [`KbLocator::parse`].
    pub fn parse(input: &str, policy: TransportPolicy) -> Result<Self, OriginError> {
        let url = Url::parse(input).map_err(|_| OriginError::Invalid)?;
        if url.fragment().is_some() {
            return Err(OriginError::NotAResource);
        }
        Self::from_url(&url, policy)
    }

    fn from_url(url: &Url, policy: TransportPolicy) -> Result<Self, OriginError> {
        let host = url.host_str().ok_or(OriginError::Invalid)?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
            return Err(OriginError::NotAResource);
        }
        if !matches!(url.path(), "" | "/" | MCP_PATH) {
            return Err(OriginError::NotAResource);
        }
        match url.scheme() {
            "https" => {}
            "http" => {
                // `Url` has already normalized IP spellings (`127.1`, `[::1]`).
                let bare = host.trim_start_matches('[').trim_end_matches(']');
                let loopback =
                    bare == "localhost" || bare.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
                if policy != TransportPolicy::AllowLoopbackHttp || !loopback {
                    return Err(OriginError::InsecureTransport);
                }
            }
            _ => return Err(OriginError::Invalid),
        }
        Ok(McpResource {
            origin: url.origin().ascii_serialization(),
        })
    }

    /// Canonical origin, `scheme://host[:port]`.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Canonical resource string, `<origin>/mcp` (the OAuth `resource`).
    pub fn as_string(&self) -> String {
        format!("{}{MCP_PATH}", self.origin)
    }

    /// The endpoint URL requests are sent to.
    pub(crate) fn endpoint(&self) -> Result<Url, OriginError> {
        Url::parse(&self.as_string()).map_err(|_| OriginError::Invalid)
    }

    pub(crate) fn is_https(&self) -> bool {
        self.origin.starts_with("https://")
    }
}

impl fmt::Debug for McpResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "McpResource({}{MCP_PATH})", self.origin)
    }
}

impl fmt::Display for McpResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{MCP_PATH}", self.origin)
    }
}

/// A remote KB attachment locator, `<canonical-origin>/mcp#kb=<id>`. The KB
/// identity is retained; [`KbLocator::resource`] is the fragment-free
/// transport/OAuth resource.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct KbLocator {
    resource: McpResource,
    kb_id: KbId,
}

impl KbLocator {
    pub fn parse(input: &str, policy: TransportPolicy) -> Result<Self, OriginError> {
        let url = Url::parse(input).map_err(|_| OriginError::Invalid)?;
        if url.path() != MCP_PATH {
            return Err(OriginError::InvalidLocator);
        }
        let kb_id = url
            .fragment()
            .and_then(|f| f.strip_prefix("kb="))
            .and_then(|id| KbId::parse(id).ok())
            .ok_or(OriginError::InvalidLocator)?;
        let mut bare = url.clone();
        bare.set_fragment(None);
        Ok(KbLocator {
            resource: McpResource::from_url(&bare, policy)?,
            kb_id,
        })
    }

    pub fn new(resource: McpResource, kb_id: KbId) -> Self {
        KbLocator { resource, kb_id }
    }

    pub fn resource(&self) -> &McpResource {
        &self.resource
    }

    pub fn kb_id(&self) -> &KbId {
        &self.kb_id
    }

    /// Canonical locator string (the attachment identity input).
    pub fn as_string(&self) -> String {
        format!("{}#kb={}", self.resource, self.kb_id)
    }
}

/// A bearer credential bound to the one resource it was minted for.
#[derive(Clone)]
pub struct Credential {
    resource: McpResource,
    token: SecretToken,
}

impl Credential {
    pub fn new(resource: McpResource, token: SecretToken) -> Self {
        Credential { resource, token }
    }

    pub fn resource(&self) -> &McpResource {
        &self.resource
    }

    pub(crate) fn token(&self) -> &SecretToken {
        &self.token
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("resource", &self.resource)
            .field("token", &self.token)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcdefghijklmnopqrstuvwx";

    fn https(input: &str) -> Result<McpResource, OriginError> {
        McpResource::parse(input, TransportPolicy::HttpsOnly)
    }

    #[test]
    fn equivalent_spellings_canonicalize_to_one_resource() {
        let canonical = https("https://kb.example.test/mcp").unwrap();
        for spelling in [
            "https://kb.example.test",
            "https://kb.example.test/",
            "HTTPS://KB.Example.TEST:443/mcp",
            "https://kb.example.test:443",
        ] {
            assert_eq!(https(spelling).unwrap(), canonical, "{spelling}");
        }
        assert_eq!(canonical.as_string(), "https://kb.example.test/mcp");
        assert_eq!(canonical.origin(), "https://kb.example.test");
        assert_ne!(https("https://kb.example.test:8443").unwrap(), canonical);
        assert_ne!(https("https://other.example.test").unwrap(), canonical);
    }

    #[test]
    fn non_resource_urls_are_rejected_without_echo() {
        for (input, error) in [
            ("kb.example.test", OriginError::Invalid),
            ("ftp://kb.example.test", OriginError::Invalid),
            ("https://user:pw@kb.example.test", OriginError::NotAResource),
            ("https://kb.example.test/mcp?x=1", OriginError::NotAResource),
            ("https://kb.example.test/api", OriginError::NotAResource),
            (
                "https://kb.example.test/mcp#kb=x",
                OriginError::NotAResource,
            ),
            ("http://kb.example.test", OriginError::InsecureTransport),
            ("http://127.0.0.1:3000", OriginError::InsecureTransport),
        ] {
            let e = https(input).unwrap_err();
            assert_eq!(e, error, "{input}");
            assert!(!e.to_string().contains("kb.example"));
        }
    }

    #[test]
    fn loopback_http_is_an_explicit_dev_opt_in() {
        let dev = |s| McpResource::parse(s, TransportPolicy::AllowLoopbackHttp);
        assert!(dev("http://127.0.0.1:3000/mcp").is_ok());
        assert!(dev("http://[::1]:3000").is_ok());
        assert!(dev("http://localhost:3000").is_ok());
        assert_eq!(
            dev("http://10.0.0.1").unwrap_err(),
            OriginError::InsecureTransport
        );
        assert_eq!(
            dev("http://kb.localhost.example").unwrap_err(),
            OriginError::InsecureTransport
        );
        assert!(!dev("http://127.0.0.1:3000").unwrap().is_https());
    }

    #[test]
    fn locator_fragment_pins_the_kb_but_not_the_resource() {
        let locator = KbLocator::parse(
            &format!("https://KB.example.test/mcp#kb={ID}"),
            TransportPolicy::HttpsOnly,
        )
        .unwrap();
        assert_eq!(locator.kb_id().as_str(), ID);
        assert_eq!(
            locator.resource(),
            &https("https://kb.example.test").unwrap()
        );
        assert_eq!(
            locator.resource().as_string(),
            "https://kb.example.test/mcp"
        );
        assert_eq!(
            locator.as_string(),
            format!("https://kb.example.test/mcp#kb={ID}")
        );

        let other = format!("https://kb.example.test/mcp#kb={}", "z".repeat(24));
        let other = KbLocator::parse(&other, TransportPolicy::HttpsOnly).unwrap();
        assert_ne!(other, locator);
        assert_eq!(other.resource(), locator.resource());

        for bad in [
            "https://kb.example.test/mcp".to_owned(),
            "https://kb.example.test/mcp#kb=UPPER".to_owned(),
            format!("https://kb.example.test/#kb={ID}"),
            format!("https://kb.example.test/mcp#id={ID}"),
        ] {
            assert_eq!(
                KbLocator::parse(&bad, TransportPolicy::HttpsOnly).unwrap_err(),
                OriginError::InvalidLocator,
                "{bad}"
            );
        }
        assert_eq!(
            KbLocator::parse(
                &format!("http://kb.example.test/mcp#kb={ID}"),
                TransportPolicy::HttpsOnly
            )
            .unwrap_err(),
            OriginError::InsecureTransport
        );
    }

    #[test]
    fn credential_debug_redacts_the_token() {
        let credential = Credential::new(
            https("https://kb.example.test").unwrap(),
            SecretToken::new("kb_pat_SECRET_CANARY".into()),
        );
        let debug = format!("{credential:?}");
        assert!(!debug.contains("SECRET_CANARY"));
        assert!(debug.contains("https://kb.example.test/mcp"));
    }
}
