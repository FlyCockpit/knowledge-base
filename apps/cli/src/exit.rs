//! Process exit codes.
//!
//! A CLI's exit code is part of its contract with scripts and agents. Keep
//! these stable and documented. The convention here:
//!
//!   0  success
//!   1  generic runtime error (the default for any `anyhow::Error`)
//!   2  usage error (clap emits this automatically for bad arguments)
//!   3  the requested resource was not found
//!
//! To give a specific error a non-default code, attach a [`CodedError`] via
//! `.context(CodedError::new(ExitCode::NotFound))` and [`code_for`] will pick it
//! up. The surrounding error should describe the concrete failure.

use std::fmt;
use std::io;

/// Stable exit codes. Document any code you add in the module comment above and
/// in `README.md` so users and scripts can rely on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum ExitCode {
    Success = 0,
    Failure = 1,
    #[allow(dead_code)] // emitted by clap, listed here for documentation.
    Usage = 2,
    /// The requested resource was not found. Construct it via
    /// `CodedError::new(ExitCode::NotFound)`.
    NotFound = 3,
}

/// Annotate an error to request a specific [`ExitCode`].
///
/// ```ignore
/// return Err(anyhow::Error::msg("no profile named `default`"))
///     .context(CodedError::new(ExitCode::NotFound));
/// ```
#[derive(Debug)]
pub struct CodedError {
    code: ExitCode,
}

impl CodedError {
    /// Create an exit-code marker.
    pub fn new(code: ExitCode) -> Self {
        Self { code }
    }

    /// Return the process exit code carried by this marker.
    pub fn code(&self) -> ExitCode {
        self.code
    }
}

impl fmt::Display for CodedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // This marker carries only the process exit code. The surrounding
        // anyhow error is responsible for the human-facing message.
        f.write_str("")
    }
}

impl std::error::Error for CodedError {}

/// Resolve the exit code for an error by looking for a [`CodedError`] anywhere
/// in it; defaults to [`ExitCode::Failure`].
pub fn code_for(err: &anyhow::Error) -> ExitCode {
    // anyhow's downcast sees a `CodedError` attached via `.context(...)`…
    if let Some(coded) = err.downcast_ref::<CodedError>() {
        return coded.code();
    }
    // …while walking the source chain sees one nested inside another error
    // (e.g. a thiserror `#[source]` field).
    for cause in err.chain() {
        if let Some(coded) = cause.downcast_ref::<CodedError>() {
            return coded.code();
        }
    }
    // A local store, model, provider or record that does not exist.
    if err.chain().any(|cause| {
        cause
            .downcast_ref::<kb_local::StoreError>()
            .is_some_and(|e| e.protocol_code() == kb_client::ErrorCode::NotFound)
    }) {
        return ExitCode::NotFound;
    }
    ExitCode::Failure
}

/// Whether this error came from writing to a downstream pipe that closed early.
pub fn is_broken_pipe(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|err| err.kind() == io::ErrorKind::BrokenPipe)
    })
}

/// Format an error for stderr, excluding exit-code-only markers.
pub fn message_for(err: &anyhow::Error) -> String {
    err.chain()
        .filter(|cause| cause.downcast_ref::<CodedError>().is_none())
        .map(std::string::ToString::to_string)
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>()
        .join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_coded_error_from_context_chain() {
        let err = anyhow::Error::msg("no profile named `default`")
            .context(CodedError::new(ExitCode::NotFound));

        assert_eq!(code_for(&err), ExitCode::NotFound);
        assert_eq!(message_for(&err), "no profile named `default`");
    }

    #[test]
    fn extracts_coded_error_nested_as_a_source() {
        // A library error that carries a `CodedError` as its `source()` —
        // the thiserror `#[source]` pattern from `docs/error-handling.md`.
        #[derive(Debug)]
        struct Wrapper {
            source: CodedError,
        }
        impl fmt::Display for Wrapper {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("wrapper failed")
            }
        }
        impl std::error::Error for Wrapper {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.source)
            }
        }

        let err = anyhow::Error::new(Wrapper {
            source: CodedError::new(ExitCode::NotFound),
        });
        assert_eq!(code_for(&err), ExitCode::NotFound);
    }

    #[test]
    fn detects_broken_pipe_through_context() {
        let err = anyhow::Error::new(io::Error::from(io::ErrorKind::BrokenPipe))
            .context("writing to stdout");

        assert!(is_broken_pipe(&err));
    }
}
