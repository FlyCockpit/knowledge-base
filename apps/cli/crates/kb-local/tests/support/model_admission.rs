//! Observe native admission before triggering cancellation/revocation. Startup
//! is not a latency assertion; the watchdog only diagnoses a stuck test.
use std::{path::Path, time::Duration};

pub fn wait_for_marker(
    marker: &Path,
    mut stopped: impl FnMut() -> Option<String>,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    loop {
        match marker.try_exists() {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => return Err(format!("admission marker {}: {error}", marker.display())),
        }
        if let Some(reason) = stopped() {
            return Err(format!(
                "operation stopped before admission marker {} after {:?}: {reason}",
                marker.display(),
                started.elapsed()
            ));
        }
        if started.elapsed() >= Duration::from_secs(120) {
            return Err(format!(
                "native admission hang watchdog: marker {} absent after {:?}; operation still running",
                marker.display(),
                started.elapsed()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
