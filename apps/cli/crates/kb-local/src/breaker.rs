//! R3-L4 (TS twin `packages/api/src/lib/kb/embed-breaker.ts`): one query
//! embedding waits at most [`QUERY_EMBEDDING_DEADLINE`], and a target
//! (provider revision or built-in model of one store) whose query embedding
//! timed out is skipped for a cooldown (a failure is fast, and a too-long
//! query says nothing about the next one): searches serve the FTS5 arm
//! at once with the notice instead of each waiting out the deadline. After
//! the cooldown one search is the half-open probe; success closes the breaker,
//! failure reopens it with a doubled cooldown, up to the maximum.
//! Process-local, like the shared worker's client pool.
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};

pub const QUERY_EMBEDDING_DEADLINE: Duration = Duration::from_secs(8);
pub const COOLDOWN: Duration = Duration::from_secs(30);
pub const MAX_COOLDOWN: Duration = Duration::from_secs(300);
const MAX_TRACKED_TARGETS: usize = 1024;

#[derive(Clone, Copy, Debug)]
struct State {
    open_until_ms: u64,
    cooldown_ms: u64,
    probing: bool,
}
static STATES: LazyLock<Mutex<HashMap<String, State>>> = LazyLock::new(Default::default);

/// Permission to embed one query; dropping it without a verdict frees a
/// half-open probe slot (cancellation, the whole search's deadline, ...).
#[derive(Debug)]
pub struct Ticket {
    key: String,
    probe: bool,
    settled: bool,
}
fn states() -> std::sync::MutexGuard<'static, HashMap<String, State>> {
    STATES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
/// A ticket, or `None` while the target must not be tried.
pub fn admit(key: &str, now_ms: u64) -> Option<Ticket> {
    let mut states = states();
    let Some(state) = states.get_mut(key) else {
        return Some(Ticket {
            key: key.into(),
            probe: false,
            settled: false,
        });
    };
    if now_ms < state.open_until_ms || state.probing {
        return None;
    }
    state.probing = true;
    Some(Ticket {
        key: key.into(),
        probe: true,
        settled: false,
    })
}
/// Drop every breaker whose key starts with `prefix` (one store's targets).
pub fn forget(prefix: &str) {
    states().retain(|key, _| !key.starts_with(prefix));
}
impl Ticket {
    pub fn succeed(mut self) {
        self.settled = true;
        states().remove(&self.key);
    }
    pub fn fail(mut self, now_ms: u64) {
        self.settled = true;
        let mut states = states();
        let prior = states.get(&self.key).copied();
        // Concurrent failures of one outage open the breaker once; only a
        // failed probe doubles the cooldown.
        if prior.is_some_and(|p| !self.probe && now_ms < p.open_until_ms) {
            return;
        }
        let cooldown_ms = prior.map_or(COOLDOWN.as_millis() as u64, |p| {
            (p.cooldown_ms * 2).min(MAX_COOLDOWN.as_millis() as u64)
        });
        if prior.is_none() && states.len() >= MAX_TRACKED_TARGETS {
            states.clear();
        }
        states.insert(
            self.key.clone(),
            State {
                open_until_ms: now_ms.saturating_add(cooldown_ms),
                cooldown_ms,
                probing: false,
            },
        );
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.settled
            && self.probe
            && let Some(state) = states().get_mut(&self.key)
        {
            state.probing = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opens_probes_once_after_the_cooldown_and_closes_on_success() {
        let key = "test-a";
        admit(key, 0).expect("closed").fail(0);
        assert!(admit(key, 1).is_none());
        assert!(admit("test-b", 1).is_some());
        let cooldown = COOLDOWN.as_millis() as u64;
        let probe = admit(key, cooldown).expect("half-open");
        assert!(probe.probe);
        assert!(admit(key, cooldown).is_none(), "one probe at a time");
        drop(probe);
        let probe = admit(key, cooldown).expect("released probe slot");
        probe.succeed();
        assert!(!admit(key, cooldown).expect("closed").probe);
    }
    #[test]
    fn a_failed_probe_doubles_the_cooldown_up_to_the_maximum() {
        let key = "test-c";
        let a = admit(key, 0).expect("closed");
        let b = admit(key, 0).expect("closed");
        a.fail(0);
        b.fail(0);
        let mut opened = 0;
        let mut cooldown = COOLDOWN.as_millis() as u64;
        assert!(
            admit(key, cooldown - 1).is_none(),
            "concurrent failures open once"
        );
        for _ in 0..6 {
            let now = opened + cooldown;
            admit(key, now).expect("probe").fail(now);
            opened = now;
            cooldown = (cooldown * 2).min(MAX_COOLDOWN.as_millis() as u64);
            assert!(admit(key, opened + cooldown - 1).is_none());
        }
        assert_eq!(cooldown, MAX_COOLDOWN.as_millis() as u64);
    }
    #[test]
    fn constants_match_the_server() {
        let ts = include_str!("../../../../../packages/api/src/lib/kb/embed-breaker.ts");
        for (name, value) in [
            ("QUERY_EMBEDDING_DEADLINE_MS", QUERY_EMBEDDING_DEADLINE),
            ("EMBED_BREAKER_COOLDOWN_MS", COOLDOWN),
            ("EMBED_BREAKER_MAX_COOLDOWN_MS", MAX_COOLDOWN),
        ] {
            let ms = value.as_millis();
            let literal = format!("{},{:03}", ms / 1000, ms % 1000).replace(',', "_");
            assert!(
                ts.contains(&format!("export const {name} = {literal};")),
                "{name}"
            );
        }
    }
}
