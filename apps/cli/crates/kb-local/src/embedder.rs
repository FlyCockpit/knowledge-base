//! Exact OpenAI response semantics, shared server cases; no raw error text.
use crate::{StoreError, egress::unavailable};
use kb_client::error::CancellationToken;
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;
/// Raw provider vectors, unchanged (f64, never rounded or normalized here):
/// the index spec normalizes exactly once, `u = f32(v / ‖v‖₂)`. Refusal rules
/// are the shared server cases: every value finite as f32 and a nonzero f32
/// norm.
pub fn validate_embeddings(
    body: &Value,
    count: usize,
    dimensions: usize,
) -> Result<Vec<Vec<f64>>, StoreError> {
    if !(1..=2000).contains(&dimensions) || count > 32 {
        return Err(unavailable());
    }
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(unavailable)?;
    if data.len() != count {
        return Err(unavailable());
    }
    let mut out = vec![None; count];
    for row in data {
        let number = row
            .get("index")
            .and_then(Value::as_f64)
            .ok_or_else(unavailable)?;
        if number < 0. || number >= count as f64 || number.fract() != 0. {
            return Err(unavailable());
        }
        let index = number as usize;
        if index >= count || out[index].is_some() {
            return Err(unavailable());
        }
        let raw = row
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(unavailable)?;
        if raw.len() != dimensions {
            return Err(unavailable());
        }
        let vector = raw
            .iter()
            .map(|v| {
                v.as_f64()
                    .filter(|v| (*v as f32).is_finite())
                    .ok_or_else(unavailable)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let norm = vector
            .iter()
            .map(|v| f64::from(*v as f32).powi(2))
            .sum::<f64>()
            .sqrt();
        if !norm.is_finite() || norm <= 0. {
            return Err(unavailable());
        }
        out[index] = Some(vector);
    }
    out.into_iter().map(|v| v.ok_or_else(unavailable)).collect()
}
// Async budgets use the timer driver's clock, so deadline checks and timeout
// futures agree, including when tests pause time around real store I/O.
#[derive(Clone, Debug)]
pub struct ProviderControl {
    cancel: CancellationToken,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}
impl Default for ProviderControl {
    fn default() -> Self {
        Self::with_timeout(Duration::from_secs(10))
    }
}
impl ProviderControl {
    pub(crate) fn transport(c: &kb_client::stdio::CallControl) -> Self {
        Self {
            cancel: c.work_token(),
            cancelled: c.work_flag(),
            ..Self::default()
        }
    }
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            cancel: CancellationToken::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + timeout.min(Duration::from_secs(10)),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.cancel.cancel();
    }
    pub(crate) fn git_scope(&self) -> crate::git_read::OperationDeadline {
        crate::git_read::OperationDeadline::bounded(
            std::time::Instant::now() + self.remaining(),
            self.cancelled.clone(),
        )
    }
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    pub(crate) fn check(&self) -> Result<(), StoreError> {
        if self.cancel.is_cancelled() {
            return Err(StoreError::OperationAborted(
                kb_client::ErrorCode::Cancelled,
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(StoreError::DeadlineExceeded);
        }
        Ok(())
    }
    pub(crate) async fn run<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, StoreError>>,
    ) -> Result<T, StoreError> {
        self.check()?;
        tokio::select! {biased;
            _=self.cancel.cancelled()=>Err(StoreError::OperationAborted(kb_client::ErrorCode::Cancelled)),
            result=tokio::time::timeout(self.remaining(),future)=>result.map_err(|_|StoreError::DeadlineExceeded)?,
        }
    }
}

/// A query's admission budget and its single target-call boundary. Admission
/// uses only `control`; call `start` after credentials and authority checks.
/// Only this boundary can classify a full target timeout for the breaker.
pub(crate) struct QueryEmbeddingControl {
    pub(crate) control: ProviderControl,
    phase: std::cell::Cell<Option<EmbeddingPhase>>,
}
#[derive(Clone, Copy)]
pub(crate) struct EmbeddingPhase {
    deadline: Instant,
    full_bound: bool,
}
impl QueryEmbeddingControl {
    pub(crate) fn new(
        deadline: Instant,
        cancel: CancellationToken,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            control: ProviderControl {
                deadline,
                cancel,
                cancelled,
            },
            phase: std::cell::Cell::new(None),
        }
    }
    /// A retry retains the first target deadline; it never grants a second budget.
    pub(crate) fn deadline(&self) -> std::time::Instant {
        self.phase
            .get()
            .map_or(self.control.deadline, EmbeddingPhase::deadline)
            .into_std()
    }
    pub(crate) fn timeout_error(&self) -> StoreError {
        self.phase
            .get()
            .map_or(StoreError::EmbeddingFailed, EmbeddingPhase::expired)
    }
    pub(crate) fn control_remaining(&self) -> Duration {
        self.control.remaining()
    }
    pub(crate) fn cancel_token(&self) -> &CancellationToken {
        &self.control.cancel
    }
    /// A child may need live admission again after connecting. Keep that
    /// work under the search budget, preserving the target time already spent.
    pub(crate) fn admit<T>(
        &self,
        admit: impl FnOnce() -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.control.check()?;
        let phase = self.phase.get();
        if let Some(phase) = phase
            && phase.remaining().is_zero()
        {
            return Err(phase.expired());
        }
        let started = Instant::now();
        let result = admit();
        if let Some(mut phase) = phase {
            let resumed = phase.deadline + started.elapsed();
            phase.deadline = resumed.min(self.control.deadline);
            phase.full_bound &= resumed <= self.control.deadline;
            self.phase.set(Some(phase));
        }
        let value = result?;
        self.control.check()?;
        Ok(value)
    }
    pub(crate) fn start(&self) -> Result<EmbeddingPhase, StoreError> {
        self.control.check()?;
        if let Some(phase) = self.phase.get() {
            return if phase.remaining().is_zero() {
                Err(phase.expired())
            } else {
                Ok(phase)
            };
        }
        let target = Instant::now() + crate::breaker::QUERY_EMBEDDING_DEADLINE;
        let deadline = self.control.deadline.min(target);
        let phase = EmbeddingPhase {
            deadline,
            full_bound: target <= deadline,
        };
        self.phase.set(Some(phase));
        Ok(phase)
    }
    pub(crate) async fn run<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, StoreError>>,
    ) -> Result<T, StoreError> {
        let phase = self.start()?;
        match tokio::time::timeout(phase.remaining(), future).await {
            // A caller's shorter transport timeout cannot blame this target
            // unless this boundary's own full budget was actually spent.
            Ok(Err(StoreError::EmbeddingTimeout)) => Err(if phase.remaining().is_zero() {
                phase.expired()
            } else {
                StoreError::EmbeddingFailed
            }),
            Ok(result) => result,
            Err(_) => Err(phase.expired()),
        }
    }
}
impl EmbeddingPhase {
    pub(crate) fn deadline(self) -> Instant {
        self.deadline
    }
    pub(crate) fn remaining(self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    pub(crate) fn expired(self) -> StoreError {
        if self.full_bound {
            StoreError::EmbeddingTimeout
        } else {
            StoreError::EmbeddingFailed
        }
    }
}

#[cfg(test)]
mod git_control_tests {
    use super::*;
    #[test]
    fn readmission_preserves_one_target_budget_and_the_search_cutoff() {
        let call = QueryEmbeddingControl::new(
            Instant::now() + Duration::from_secs(60),
            CancellationToken::new(),
            Arc::new(AtomicBool::new(false)),
        );
        // No target clock during initial authority admission.
        call.admit(|| Ok(())).expect("admitted");
        assert!(call.phase.get().is_none());
        let first = call.start().expect("target starts");
        assert_eq!(
            call.start().expect("same call").deadline(),
            first.deadline()
        );
        call.admit(|| {
            std::thread::sleep(Duration::from_millis(20));
            Ok(())
        })
        .expect("readmitted");
        let resumed = call.start().expect("same budget after readmission");
        assert!(resumed.deadline() >= first.deadline() + Duration::from_millis(20));
        assert!(matches!(resumed.expired(), StoreError::EmbeddingTimeout));
        // Dispatch-time expiry belongs to this boundary, before any new
        // authority callback can mask it as a generic admission deadline.
        call.phase.set(Some(EmbeddingPhase {
            deadline: Instant::now() - Duration::from_millis(1),
            ..resumed
        }));
        assert!(matches!(
            call.admit(|| -> Result<(), StoreError> { panic!("expired target must not dispatch") }),
            Err(StoreError::EmbeddingTimeout)
        ));
        // A search cut short during authority work cannot blame the target.
        let short = QueryEmbeddingControl::new(
            Instant::now() + Duration::from_millis(100),
            CancellationToken::new(),
            Arc::new(AtomicBool::new(false)),
        );
        assert!(matches!(
            short.start().expect("short call").expired(),
            StoreError::EmbeddingFailed
        ));
        assert!(matches!(
            short.admit(|| {
                std::thread::sleep(Duration::from_millis(150));
                Ok(())
            }),
            Err(StoreError::DeadlineExceeded)
        ));
        assert!(matches!(short.timeout_error(), StoreError::EmbeddingFailed));
    }
    #[test]
    fn git_scope_shares_deadline_cancellation_and_restores_on_exit() {
        let ctl = ProviderControl::default();
        let scope = ctl.git_scope();
        ctl.cancel();
        assert_eq!(
            crate::git_read::OperationDeadline::check()
                .unwrap_err()
                .protocol_code(),
            kb_client::ErrorCode::Cancelled
        );
        drop(scope);
        assert!(crate::git_read::OperationDeadline::check().is_ok());
        let expired = ProviderControl::with_timeout(Duration::ZERO);
        let _scope = expired.git_scope();
        assert_eq!(
            crate::git_read::OperationDeadline::check()
                .unwrap_err()
                .protocol_code(),
            kb_client::ErrorCode::DeadlineExceeded
        );
    }
}
