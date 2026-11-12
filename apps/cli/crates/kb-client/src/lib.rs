//! Reusable kb/1 protocol contract for knowledge-base MCP clients.
//!
//! * [`types`] — closed camelCase input/output types for every catalog tool,
//!   the pinned [`ToolName`] catalog and the [`Tool`] trait.
//! * [`schema`] — evaluator for the canonical TypeScript-generated JSON Schema
//!   artifact, embedded at compile time; the same verdicts as the server.
//! * [`error`] — the closed error union, protocol violations, cancellation and
//!   deadlines.
//! * [`origin`] — canonical `/mcp` resources, KB locators and origin-bound
//!   credentials.
//! * [`protocol`] / [`client`] — the explicit MCP 2026-07-28 stateless HTTP
//!   profile and the origin-bound [`McpClient`].
//!
//! * [`attachment`] / [`snapshot`] / [`dream`] / [`sealed`] — Cockpit host
//!   adapter seams: attachment identity, verified immutable retrieval, the
//!   one-call atomic dream apply and host-only sealed resolution.
//!
//! * [`scope`] — a local session's tool groups, write mode and KB selection,
//!   with the server's discovery and authorization rules.
//!
//! * [`export`] — bounded verified ZIP retrieval with a receipt bound to the
//!   preparing client for acknowledgement after durable host-side save.
//!
//! This crate has no CLI or UI dependency. Other transports (local stdio)
//! build on [`encode_input`] / [`decode_envelope`].

pub mod attachment;
pub mod client;
pub mod dream;
pub mod envelope;
pub mod error;
pub mod export;
pub mod origin;
mod path;
pub mod protocol;
pub mod schema;
pub mod scope;
pub mod sealed;
pub mod snapshot;
pub mod stdio;
pub mod types;

use serde::Serialize;
use serde_json::{Map, Value};

pub use error::{CancellationToken, Deadline, ErrorCode, KbError, ProtocolError, ToolError};
pub use path::{PATH_MAX_BYTES, PATH_MAX_SEGMENTS, PathIssue, casefold_path_key, check_kb_path};
pub use types::{SecretToken, Tool, ToolName};

pub use client::{CallControl, ClientError, McpClient};
pub use origin::{Credential, KbLocator, McpResource, OriginError, TransportPolicy};
pub use protocol::{
    ClientOptions, MCP_PROFILE, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, ServerDiscovery,
};

use schema::Direction;

/// The only protocol discriminator this client speaks.
pub const PROTOCOL_VERSION: &str = "kb/1";

fn serialize<T: Serialize>(value: &T, direction: Direction) -> Result<Value, KbError> {
    serde_json::to_value(value).map_err(|_| violation(direction, types::typed_violation()))
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
        .map_err(|_| violation(Direction::Input, types::typed_violation()))
}

/// Validate and type a tool's `data` payload.
pub fn decode_output<T: Tool>(value: Value) -> Result<T::Output, KbError> {
    let value = validated::<T>(value, Direction::Output)?;
    serde_json::from_value(schema::normalize_integers(value))
        .map_err(|_| violation(Direction::Output, types::typed_violation()))
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
