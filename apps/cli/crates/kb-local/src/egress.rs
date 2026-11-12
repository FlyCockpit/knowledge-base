//! Positive global-address policy matching packages/config/src/egress-address.ts.
//! DNS is resolved afresh per request; the chosen socket is pinned while the
//! original URL retains Host/SNI/certificate verification. Never use proxies.
use crate::{StoreError, credentials::Secret};
use reqwest::Url;
use std::{
    collections::HashMap,
    future::Future,
    net::{IpAddr, SocketAddr},
    pin::Pin,
};
use tokio::sync::watch;
pub type IoFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, StoreError>> + 'a>>;
pub fn unavailable() -> StoreError {
    StoreError::IndexUnavailable
}
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, d] = ip.octets();
            if [a, b, c] == [192, 0, 0] && [9, 10].contains(&d) {
                return true;
            }
            !(a == 0
                || a == 10
                || (a == 100 && (64..=127).contains(&b))
                || a == 127
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && ((b == 0 && [0, 2].contains(&c)) || (b == 88 && c == 99) || b == 168))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            let v = u128::from(ip);
            let within = |prefix: u128, bits: u32| v >> (128 - bits) == prefix >> (128 - bits);
            if within(0xffff << 32, 96) || within(0x0064ff9bu128 << 96, 96) {
                return is_public(IpAddr::V4((v as u32).into()));
            }
            if !within(0x2000 << 112, 3) {
                return false;
            }
            if within(0x2001 << 112, 23) {
                return [
                    0x20010001000000000000000000000001,
                    0x20010001000000000000000000000002,
                    0x20010001000000000000000000000003,
                ]
                .contains(&v)
                    || [
                        (0x20010003 << 96, 32),
                        (0x200100040112 << 80, 48),
                        (0x20010020 << 96, 28),
                        (0x20010030 << 96, 28),
                    ]
                    .iter()
                    .any(|(p, b)| within(*p, *b));
            }
            ![
                (0x20010db8 << 96, 32),
                (0x2002 << 112, 16),
                (0x3fff << 112, 20),
            ]
            .iter()
            .any(|(p, b)| within(*p, *b))
        }
    }
}
#[derive(Clone, Debug)]
pub struct Endpoint {
    url: Url,
}
impl Endpoint {
    pub fn parse(raw: &str, allow_loopback: bool) -> Result<Self, StoreError> {
        // L-10: say which endpoint rule failed; the wire code is unchanged.
        let refuse = |why: &str| {
            StoreError::Explained(
                kb_client::ErrorCode::IndexUnavailable,
                format!("provider endpoint refused: {why}"),
            )
        };
        if raw.len() > 2048 {
            return Err(refuse("longer than 2048 bytes"));
        }
        let url = Url::parse(raw).map_err(|_| refuse("not an absolute URL"))?;
        let host = url
            .host_str()
            .ok_or_else(|| refuse("no host"))?
            .trim_matches(['[', ']']);
        let literal = host.parse::<IpAddr>().ok();
        let dev = allow_loopback && literal.is_some_and(|ip| ip.is_loopback());
        if !url.username().is_empty() || url.password().is_some() {
            return Err(refuse(
                "credentials in the URL; pass the key with `--key-stdin`",
            ));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(refuse("a query string or fragment"));
        }
        if literal.is_some_and(|ip| !is_public(ip) && !dev) {
            return Err(refuse(
                "a loopback or private address; only literal loopback is allowed, after `kb providers loopback --enabled`",
            ));
        }
        if !(url.scheme() == "https" || (dev && url.scheme() == "http")) {
            return Err(refuse(
                "not https (plain http only for literal loopback after `kb providers loopback --enabled`)",
            ));
        }
        Ok(Self { url })
    }
    pub fn url(&self) -> &Url {
        &self.url
    }
    pub fn host(&self) -> &str {
        self.url
            .host_str()
            .expect("validated host")
            .trim_matches(['[', ']'])
    }
    fn port(&self) -> u16 {
        self.url.port_or_known_default().expect("validated scheme")
    }
}
pub trait Dns {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> IoFuture<'a, Vec<IpAddr>>;
}
pub trait Http {
    fn post<'a>(
        &'a self,
        e: &'a Endpoint,
        addr: SocketAddr,
        secret: &'a Secret,
        body: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse>;
}
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}
pub struct PinnedEgress<'a> {
    dns: &'a dyn Dns,
    http: &'a dyn Http,
}
impl<'a> PinnedEgress<'a> {
    pub fn new(dns: &'a dyn Dns, http: &'a dyn Http) -> Self {
        Self { dns, http }
    }
    pub(crate) async fn post(
        &self,
        e: &Endpoint,
        secret: &Secret,
        body: Vec<u8>,
        query: Option<&crate::embedder::QueryEmbeddingControl>,
        before_dispatch: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<Vec<u8>, StoreError> {
        if body.len() > 2 * 1024 * 1024 {
            return Err(unavailable());
        }
        // A query's target boundary owns ALL of its target I/O: resolution,
        // connect, TLS, request and response share one cumulative budget.
        // Only the authority recheck between them pauses that clock.
        let ips = match e.host().parse::<IpAddr>() {
            Ok(ip) => vec![ip],
            Err(_) => target(query, self.dns.resolve(e.host(), e.port())).await?,
        };
        // Only a literal loopback URL can invoke the owner development exception.
        let dev = e.host().parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if ips.is_empty()
            || ips
                .iter()
                .any(|ip| !is_public(*ip) && !(dev && ip.is_loopback()))
        {
            return Err(unavailable());
        }
        match query {
            Some(query) => query.admit(before_dispatch)?,
            None => before_dispatch()?,
        }
        let reply = target(
            query,
            self.http
                .post(e, SocketAddr::new(ips[0], e.port()), secret, body),
        )
        .await?;
        if reply.status != 200 || reply.body.len() > 8 * 1024 * 1024 {
            return Err(unavailable());
        }
        Ok(reply.body)
    }
}
/// One step of a query's target I/O, inside its cumulative boundary.
async fn target<T>(
    query: Option<&crate::embedder::QueryEmbeddingControl>,
    io: IoFuture<'_, T>,
) -> Result<T, StoreError> {
    let io = async { io.await.map_err(|_| unavailable()) };
    match query {
        Some(query) => query.run(io).await,
        None => io.await,
    }
}
/// The system resolver. `getaddrinfo` cannot be cancelled, so it runs on a
/// detached thread that belongs to no runtime: a caller whose budget ends
/// simply stops waiting, and no runtime shutdown or reply ever waits for it.
/// At most one lookup per host is outstanding; callers meanwhile share it.
pub struct NativeDns;
impl Dns for NativeDns {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> IoFuture<'a, Vec<IpAddr>> {
        static SYSTEM: Lookups = Lookups::new();
        Box::pin(SYSTEM.resolve(host, port, |host, port| {
            use std::net::ToSocketAddrs;
            Ok((host, port).to_socket_addrs()?.map(|a| a.ip()).collect())
        }))
    }
}
type Answer = Option<Result<Vec<IpAddr>, ()>>;
/// The outstanding blocking lookups, one per host.
struct Lookups(std::sync::Mutex<Option<HashMap<String, watch::Receiver<Answer>>>>);
impl Lookups {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
    fn entries(
        &self,
    ) -> std::sync::MutexGuard<'_, Option<HashMap<String, watch::Receiver<Answer>>>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    async fn resolve(
        &'static self,
        host: &str,
        port: u16,
        blocking: fn(&str, u16) -> std::io::Result<Vec<IpAddr>>,
    ) -> Result<Vec<IpAddr>, StoreError> {
        let key = host.to_ascii_lowercase();
        let mut answer = {
            let mut entries = self.entries();
            let entries = entries.get_or_insert_with(HashMap::new);
            // A lookup thread that died without answering left a closed
            // channel behind: start afresh instead of failing every caller.
            match entries.get(&key).filter(|o| o.has_changed().is_ok()) {
                Some(outstanding) => outstanding.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    let owned = key.clone();
                    std::thread::Builder::new()
                        .name("kb-dns".into())
                        .spawn(move || {
                            let answer = blocking(&owned, port).map_err(|_| ());
                            // Only this thread removes its own entry.
                            if let Some(entries) = self.entries().as_mut() {
                                entries.remove(&owned);
                            }
                            let _ = tx.send(Some(answer));
                        })
                        .map_err(|_| unavailable())?;
                    entries.insert(key, rx.clone());
                    rx
                }
            }
        };
        let answer = answer
            .wait_for(Option::is_some)
            .await
            .map_err(|_| unavailable())?
            .clone();
        answer.and_then(Result::ok).ok_or_else(unavailable)
    }
}
pub struct NativeHttp;
impl Http for NativeHttp {
    fn post<'a>(
        &'a self,
        e: &'a Endpoint,
        addr: SocketAddr,
        secret: &'a Secret,
        body: Vec<u8>,
    ) -> IoFuture<'a, HttpResponse> {
        Box::pin(async move {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .referer(false)
                .resolve(e.host(), addr)
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|_| unavailable())?;
            let mut authorization =
                reqwest::header::HeaderValue::from_str(&format!("Bearer {}", secret.expose()))
                    .map_err(|_| unavailable())?;
            authorization.set_sensitive(true);
            let mut reply = http
                .post(e.url.clone())
                .header(reqwest::header::AUTHORIZATION, authorization)
                .header("content-type", "application/json")
                .header("accept", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|_| unavailable())?;
            let status = reply.status().as_u16();
            if status != 200 {
                return Err(unavailable());
            }
            let mut body = Vec::new();
            while let Some(chunk) = reply.chunk().await.map_err(|_| unavailable())? {
                if body.len() + chunk.len() > 8 * 1024 * 1024 {
                    return Err(unavailable());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpResponse { status, body })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{Duration, Instant};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    static GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
    fn open(open: bool) {
        *GATE.0.lock().expect("gate") = open;
        GATE.1.notify_all();
    }
    /// A system resolver that blocks its thread until the gate opens.
    fn stalled(_: &str, _: u16) -> std::io::Result<Vec<IpAddr>> {
        CALLS.fetch_add(1, Ordering::SeqCst);
        let mut open = GATE.0.lock().expect("gate");
        while !*open {
            open = GATE.1.wait(open).expect("gate");
        }
        Ok(vec![IpAddr::from([8, 8, 8, 8])])
    }
    #[test]
    fn one_blocking_lookup_per_host_outlives_abandoned_callers_and_is_shared() {
        static LOOKUPS: Lookups = Lookups::new();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        open(false);
        // Abandoned callers: each gives up while the thread stays blocked.
        for _ in 0..5 {
            let started = Instant::now();
            let gave_up = rt.block_on(async {
                tokio::time::timeout(
                    Duration::from_millis(50),
                    LOOKUPS.resolve("Stalled.Example", 443, stalled),
                )
                .await
            });
            assert!(gave_up.is_err());
            assert!(started.elapsed() < Duration::from_secs(1));
        }
        assert_eq!(
            CALLS.load(Ordering::SeqCst),
            1,
            "one outstanding lookup per host"
        );
        // Dropping the runtime never waits for the detached lookup.
        let started = Instant::now();
        drop(rt);
        assert!(started.elapsed() < Duration::from_secs(1));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let answer = rt.block_on(async {
            let waiting = LOOKUPS.resolve("stalled.example", 443, stalled);
            let release = async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                open(true);
            };
            tokio::join!(waiting, release).0
        });
        assert_eq!(answer.expect("shared answer"), [IpAddr::from([8, 8, 8, 8])]);
        assert_eq!(
            CALLS.load(Ordering::SeqCst),
            1,
            "the waiter joined the stalled lookup"
        );
        // Answered lookups are not cached: the next request resolves afresh.
        rt.block_on(LOOKUPS.resolve("stalled.example", 443, stalled))
            .expect("fresh answer");
        assert_eq!(CALLS.load(Ordering::SeqCst), 2);
    }
}
