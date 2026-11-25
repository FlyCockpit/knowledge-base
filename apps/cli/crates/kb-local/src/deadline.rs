//! The operation scope: one absolute deadline and cancel flag shared by every
//! Git handle, child and lock admission on the calling thread.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use crate::StoreError;

thread_local! {
    static OPERATION_CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) };
    static OPERATION_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
    static OPERATION_CLOCK: std::cell::Cell<fn() -> Instant> = const { std::cell::Cell::new(Instant::now) };
}

thread_local! { static TRANSPORT_CONTROL: std::cell::RefCell<Option<kb_client::mcp::stdio::CallControl>> = const { std::cell::RefCell::new(None) }; }
/// Synchronous service scope: every Git handle/child shares one absolute
/// deadline, including readers opened by recovery and the dream guard.
pub(crate) struct OperationDeadline(
    Option<Instant>,
    Option<Arc<AtomicBool>>,
    Option<Option<kb_client::mcp::stdio::CallControl>>,
    fn() -> Instant,
);
impl OperationDeadline {
    pub(crate) fn now() -> Instant {
        (OPERATION_CLOCK.get())()
    }
    pub(crate) fn transport(control: kb_client::mcp::stdio::CallControl) -> Self {
        let mut scope = Self::bounded(control.until(), control.work_flag());
        scope.2 = Some(TRANSPORT_CONTROL.replace(Some(control)));
        scope
    }
    pub(crate) fn reserve_transport() -> Result<(), StoreError> {
        Self::check()?;
        TRANSPORT_CONTROL.with(|c| {
            if let Some(c) = c.borrow().as_ref() {
                c.reserve().map_err(StoreError::OperationAborted)?;
                OPERATION_CANCEL.replace(None);
            }
            Ok(())
        })
    }

    pub(crate) fn start() -> Self {
        Self::with_timeout(Duration::from_secs(30))
    }
    /// A nested scope that ends at `budget` from now or at the enclosing
    /// deadline, whichever is first (maintenance inside a caller's call).
    pub(crate) fn budget(budget: Duration) -> Self {
        Self::with_timeout(budget)
    }
    /// Time left in the current scope (zero once cancelled); `None` without
    /// a deadline.
    pub(crate) fn remaining() -> Option<Duration> {
        if OPERATION_CANCEL.with(|c| {
            c.borrow()
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
        }) {
            return Some(Duration::ZERO);
        }
        OPERATION_DEADLINE
            .get()
            .map(|deadline| deadline.saturating_duration_since(Self::now()))
    }
    // Tests shorten the same thread-local operation scope; production enters
    // through start() (the thirty-second service bound) or a nested budget.
    fn with_timeout(timeout: Duration) -> Self {
        let deadline = Self::now() + timeout;
        Self(
            OPERATION_DEADLINE.replace(Some(
                OPERATION_DEADLINE
                    .get()
                    .map_or(deadline, |old| old.min(deadline)),
            )),
            OPERATION_CANCEL.with(|c| c.borrow().clone()),
            None,
            OPERATION_CLOCK.get(),
        )
    }
    pub(crate) fn bounded(deadline: Instant, cancel: Arc<AtomicBool>) -> Self {
        Self::bounded_with_clock(deadline, cancel, Instant::now)
    }
    pub(crate) fn bounded_with_clock(
        deadline: Instant,
        cancel: Arc<AtomicBool>,
        clock: fn() -> Instant,
    ) -> Self {
        Self(
            OPERATION_DEADLINE.replace(Some(
                OPERATION_DEADLINE
                    .get()
                    .map_or(deadline, |old| old.min(deadline)),
            )),
            OPERATION_CANCEL.replace(Some(cancel)),
            None,
            OPERATION_CLOCK.replace(clock),
        )
    }
    #[cfg(test)]
    pub(crate) fn for_test(timeout: Duration) -> Self {
        Self::with_timeout(timeout)
    }
    pub(crate) fn check() -> Result<(), StoreError> {
        if OPERATION_CANCEL.with(|c| {
            c.borrow()
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
        }) {
            return Err(StoreError::OperationAborted(
                kb_client::ErrorCode::Cancelled,
            ));
        }
        if OPERATION_DEADLINE.get().is_some_and(|d| Self::now() >= d) {
            return Err(StoreError::DeadlineExceeded);
        }
        Ok(())
    }
}
impl Drop for OperationDeadline {
    fn drop(&mut self) {
        OPERATION_DEADLINE.set(self.0);
        OPERATION_CLOCK.set(self.3);
        OPERATION_CANCEL.set(self.1.clone());
        if let Some(old) = self.2.take() {
            TRANSPORT_CONTROL.set(old);
        }
    }
}

/// The calling thread's scope, copied for a watchdog thread that kills a
/// child when the scope ends.
pub(crate) struct ScopeWatch {
    deadline: Option<Instant>,
    clock: fn() -> Instant,
    cancel: Option<Arc<AtomicBool>>,
}
impl ScopeWatch {
    pub(crate) fn current() -> Self {
        Self {
            deadline: OPERATION_DEADLINE.get(),
            clock: OPERATION_CLOCK.get(),
            cancel: OPERATION_CANCEL.with(|c| c.borrow().clone()),
        }
    }
    /// The scope's deadline has passed on its own (possibly injected) clock.
    pub(crate) fn expired(&self) -> bool {
        self.deadline.is_some_and(|d| (self.clock)() >= d)
    }
    pub(crate) fn cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Acquire))
    }
    /// The longest wait before the next check: `remaining`, capped by the
    /// scope's deadline, and by 10 ms while cancellation can arrive.
    pub(crate) fn bound(&self, mut remaining: Duration) -> Duration {
        if let Some(d) = self.deadline {
            remaining = remaining.min(d.saturating_duration_since((self.clock)()));
        }
        if self.cancel.is_some() {
            remaining = remaining.min(Duration::from_millis(10));
        }
        remaining
    }
}

#[cfg(test)]
mod operation_clock_tests {
    use super::*;

    fn paused_clock() -> Instant {
        static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        *EPOCH.get_or_init(|| Instant::now() + Duration::from_secs(3600))
    }

    #[test]
    fn nested_budgets_and_remaining_use_the_enclosing_operation_clock() {
        let cancel = Arc::new(AtomicBool::new(false));
        let outer = OperationDeadline::bounded_with_clock(
            paused_clock() + Duration::from_secs(30),
            cancel.clone(),
            paused_clock,
        );
        assert_eq!(
            OperationDeadline::remaining(),
            Some(Duration::from_secs(30))
        );
        {
            let _budget = OperationDeadline::budget(Duration::from_secs(2));
            assert_eq!(OperationDeadline::remaining(), Some(Duration::from_secs(2)));
            assert!(OperationDeadline::check().is_ok());
            let _longer = OperationDeadline::budget(Duration::from_secs(60));
            assert_eq!(OperationDeadline::remaining(), Some(Duration::from_secs(2)));
        }
        assert_eq!(
            OperationDeadline::remaining(),
            Some(Duration::from_secs(30))
        );
        cancel.store(true, Ordering::Release);
        assert_eq!(OperationDeadline::remaining(), Some(Duration::ZERO));
        drop(outer);
        assert_eq!(OperationDeadline::remaining(), None);
    }
}
