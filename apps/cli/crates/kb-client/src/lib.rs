//! Reusable kb/1 protocol contract for knowledge-base MCP clients.
//!
//! Layers, each using only the ones below it:
//!
//! * [`host`] — Cockpit host adapter seams: [`host::attachment`] identity,
//!   [`host::snapshot`] verified immutable retrieval, the one-call atomic
//!   [`host::dream`] apply, host-only [`host::sealed`] resolution and bounded
//!   verified [`host::export`] retrieval with a receipt bound to the preparing
//!   client.
//! * [`mcp`] — the MCP transports: [`mcp::stdio`] (the bounded newline server)
//!   and [`mcp::client`] (the origin-bound [`McpClient`]) over
//!   [`mcp::protocol`] (the explicit MCP 2026-07-28 stateless HTTP profile),
//!   [`mcp::catalog`] (what a session advertises), [`mcp::scope`] (a local
//!   session's tool groups, read-only flag, write mode and KB selection, with
//!   the server's discovery and authorization rules) and [`mcp::origin`]
//!   (canonical `/mcp` resources, KB locators and origin-bound credentials).
//! * [`envelope`] — the MCP per-request `_meta` envelope.
//! * [`tools`] — the pinned [`ToolName`] catalog, the [`Tool`] trait and each
//!   tool's write-mode need; the codec below ([`encode_input`] /
//!   [`decode_envelope`]) runs every value through it.
//! * [`error`] — the closed error union, protocol violations, cancellation and
//!   deadlines.
//! * [`schema`] — evaluator for the canonical TypeScript-generated JSON Schema
//!   artifact, embedded at compile time; the same verdicts as the server.
//! * [`authoring`] — write modes (`dream` / `edit` / `both`) and the document
//!   provenance rules dreams follow.
//! * [`types`] — closed camelCase input/output value types.
//! * `format` / `path` — lexical identifier, instant and integer formats and
//!   kb path rules.
//!
//! This crate has no CLI or UI dependency.

pub mod authoring;
pub mod envelope;
pub mod error;
mod format;
mod path;
pub mod schema;
pub mod tools;
pub mod types;

/// MCP transports and the tool lists they advertise.
pub mod mcp {
    pub mod catalog;
    pub mod client;
    pub mod origin;
    pub mod protocol;
    pub mod scope;
    pub mod stdio;
}

/// Cockpit host adapter seams over [`crate::McpClient`].
pub mod host {
    pub mod attachment;
    pub mod dream;
    pub mod export;
    pub mod sealed;
    pub mod snapshot;
}

pub use error::{CancellationToken, Deadline, ErrorCode, KbError, ProtocolError, ToolError};
pub use path::{PATH_MAX_BYTES, PATH_MAX_SEGMENTS, PathIssue, casefold_path_key, check_kb_path};
pub use tools::{Tool, ToolName};
pub use types::SecretToken;

pub use mcp::client::{CallControl, McpClient};
pub use mcp::origin::{Credential, KbLocator, McpResource, OriginError, TransportPolicy};
pub use mcp::protocol::{
    ClientError, ClientOptions, MCP_PROFILE, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, ServerDiscovery,
};

use serde::Serialize;
use serde_json::{Map, Value};

use schema::Direction;

/// The only protocol discriminator this client speaks.
pub const PROTOCOL_VERSION: &str = "kb/1";

fn serialize<T: Serialize>(value: &T, direction: Direction) -> Result<Value, KbError> {
    serde_json::to_value(value).map_err(|_| violation(direction, tools::typed_violation()))
}

fn violation(direction: Direction, violation: schema::SchemaViolation) -> KbError {
    KbError::Protocol(match direction {
        Direction::Input => ProtocolError::InvalidInput(violation),
        Direction::Output => ProtocolError::InvalidOutput(violation),
    })
}

fn validated<T: Tool>(value: Value, direction: Direction) -> Result<Value, KbError> {
    schema::validate(T::NAME.as_str(), direction, &value).map_err(|v| violation(direction, v))?;
    Ok(value)
}

/// Serialize a typed input and enforce the full contract (bounds, byte caps,
/// paths, instants, cross-field rules) before it leaves the process.
pub fn encode_input<T: Tool>(input: &T::Input) -> Result<Value, KbError> {
    validated::<T>(serialize(input, Direction::Input)?, Direction::Input)
}

/// Validate and type an untrusted tool input (e.g. from a local agent).
pub fn decode_input<T: Tool>(value: Value) -> Result<T::Input, KbError> {
    let value = validated::<T>(value, Direction::Input)?;
    serde_json::from_value(schema::normalize_integers(value))
        .map_err(|_| violation(Direction::Input, tools::typed_violation()))
}

/// Validate and type a tool's `data` payload.
pub fn decode_output<T: Tool>(value: Value) -> Result<T::Output, KbError> {
    let value = validated::<T>(value, Direction::Output)?;
    serde_json::from_value(schema::normalize_integers(value))
        .map_err(|_| violation(Direction::Output, tools::typed_violation()))
}

/// Serialize a typed output, enforcing the contract (local backends).
pub fn encode_output<T: Tool>(output: &T::Output) -> Result<Value, KbError> {
    validated::<T>(serialize(output, Direction::Output)?, Direction::Output)
}

/// Decode a `structuredContent` kb/1 envelope: `{schemaVersion, data}` yields
/// the typed output, `{schemaVersion, error}` a [`KbError::Tool`]. A missing or
/// different `schemaVersion` is [`ProtocolError::SchemaVersionMismatch`].
pub fn decode_envelope<T: Tool>(structured: Value) -> Result<T::Output, KbError> {
    let Value::Object(mut object) = structured else {
        return Err(ProtocolError::MalformedEnvelope.into());
    };
    if object.get("schemaVersion").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
        return Err(ProtocolError::SchemaVersionMismatch.into());
    }
    if object.len() != 2 {
        return Err(ProtocolError::MalformedEnvelope.into());
    }
    if let Some(data) = object.remove("data") {
        return decode_output::<T>(data);
    }
    if let Some(error) = object.remove("error") {
        return Err(ToolError::from_value(&error)?.into());
    }
    Err(ProtocolError::MalformedEnvelope.into())
}

/// Build the success `structuredContent` envelope for a typed output.
pub fn encode_success_envelope<T: Tool>(output: &T::Output) -> Result<Value, KbError> {
    let mut object = Map::new();
    object.insert("schemaVersion".into(), Value::from(PROTOCOL_VERSION));
    object.insert("data".into(), encode_output::<T>(output)?);
    Ok(Value::Object(object))
}

/// Build the error `structuredContent` envelope.
pub fn encode_error_envelope(error: &ToolError) -> Value {
    let mut object = Map::new();
    object.insert("schemaVersion".into(), Value::from(PROTOCOL_VERSION));
    object.insert("error".into(), error.to_value());
    Value::Object(object)
}
