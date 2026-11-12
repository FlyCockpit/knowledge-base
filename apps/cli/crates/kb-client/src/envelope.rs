//! The MCP 2026-07-28 per-request `_meta` envelope, validated field by field
//! as the pinned server SDK (`@modelcontextprotocol/server`, its
//! `RequestMetaEnvelopeSchema` / `validateEnvelopeMeta`) does: the two required
//! keys first, then each reserved key in the SDK's schema order, reporting the
//! first issue as `{key, problem}` with the SDK's key path (`.`-joined) and
//! Zod's problem wording. Foreign keys pass through, as in the SDK's loose
//! schema; unknown members of a capability object are ignored (Zod strips
//! them). Ordinary request metadata is validated from the generated SDK schema
//! in `schema::validate_request_meta` before envelope admission.
use serde_json::{Map, Value};

pub const PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const LOG_LEVEL: &str = "io.modelcontextprotocol/logLevel";
const LOG_LEVELS: [&str; 8] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
];

/// The first envelope problem: the key path and what is wrong with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvelopeIssue {
    pub key: String,
    pub problem: String,
}

type Check = Result<(), EnvelopeIssue>;

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn issue(key: &[&str], problem: String) -> EnvelopeIssue {
    EnvelopeIssue {
        key: key.join("."),
        problem,
    }
}

fn expected(key: &[&str], kind: &str, value: Option<&Value>) -> EnvelopeIssue {
    issue(
        key,
        format!(
            "Invalid input: expected {kind}, received {}",
            received(value)
        ),
    )
}

/// `z.string()` (`optional`: absent is fine).
fn string(key: &[&str], value: Option<&Value>, optional: bool) -> Check {
    match value {
        None if optional => Ok(()),
        Some(Value::String(_)) => Ok(()),
        other => Err(expected(key, "string", other)),
    }
}

fn boolean(key: &[&str], value: Option<&Value>) -> Check {
    match value {
        None | Some(Value::Bool(_)) => Ok(()),
        other => Err(expected(key, "boolean", other)),
    }
}

/// `JSONObjectSchema` (`z.record(z.string(), JSON)`): any JSON object.
fn record(key: &[&str], value: Option<&Value>) -> Check {
    match value {
        None | Some(Value::Object(_)) => Ok(()),
        other => Err(expected(key, "record", other)),
    }
}

/// `z.record(z.string(), JSONObjectSchema)`: an object of objects.
fn record_of_records(key: &[&str], value: Option<&Value>) -> Check {
    let Some(value) = value else { return Ok(()) };
    let Value::Object(map) = value else {
        return Err(expected(key, "record", Some(value)));
    };
    for (member, child) in map {
        let mut path = key.to_vec();
        path.push(member);
        record(&path, Some(child))?;
    }
    Ok(())
}

/// `z.object({...})`: absent (when optional) or an object.
fn object<'a>(
    key: &[&str],
    value: Option<&'a Value>,
    optional: bool,
) -> Result<Option<&'a Map<String, Value>>, EnvelopeIssue> {
    match value {
        None if optional => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        other => Err(expected(key, "object", other)),
    }
}

fn path<'a>(key: &[&'a str], member: &'a str) -> Vec<&'a str> {
    let mut path = key.to_vec();
    path.push(member);
    path
}

/// `ImplementationSchema`: name, title?, icons?, version, websiteUrl?, description?.
fn implementation(key: &[&str], value: Option<&Value>) -> Check {
    let Some(map) = object(key, value, true)? else {
        return Ok(());
    };
    string(&path(key, "name"), map.get("name"), false)?;
    string(&path(key, "title"), map.get("title"), true)?;
    if let Some(icons) = map.get("icons") {
        let at = path(key, "icons");
        let Value::Array(items) = icons else {
            return Err(expected(&at, "array", Some(icons)));
        };
        for (index, icon) in items.iter().enumerate() {
            let index = index.to_string();
            let at = path(&at, &index);
            let icon = object(&at, Some(icon), false)?.expect("required");
            string(&path(&at, "src"), icon.get("src"), false)?;
            string(&path(&at, "mimeType"), icon.get("mimeType"), true)?;
            if let Some(sizes) = icon.get("sizes") {
                let sizes_at = path(&at, "sizes");
                let Value::Array(sizes) = sizes else {
                    return Err(expected(&sizes_at, "array", Some(sizes)));
                };
                for (i, size) in sizes.iter().enumerate() {
                    let i = i.to_string();
                    string(&path(&sizes_at, &i), Some(size), false)?;
                }
            }
            match icon.get("theme") {
                None => {}
                Some(Value::String(t)) if t == "light" || t == "dark" => {}
                Some(_) => {
                    return Err(issue(
                        &path(&at, "theme"),
                        "Invalid option: expected one of \"light\"|\"dark\"".into(),
                    ));
                }
            }
        }
    }
    string(&path(key, "version"), map.get("version"), false)?;
    string(&path(key, "websiteUrl"), map.get("websiteUrl"), true)?;
    string(&path(key, "description"), map.get("description"), true)
}

/// `ClientCapabilities2026Schema`: experimental?, sampling?, elicitation?,
/// roots?, extensions? (2025-era `tasks` is not part of it and is ignored).
fn capabilities(key: &[&str], value: Option<&Value>) -> Check {
    let map = object(key, value, false)?.expect("required");
    record_of_records(&path(key, "experimental"), map.get("experimental"))?;
    if let Some(sampling) = object(&path(key, "sampling"), map.get("sampling"), true)? {
        let at = path(key, "sampling");
        record(&path(&at, "context"), sampling.get("context"))?;
        record(&path(&at, "tools"), sampling.get("tools"))?;
    }
    if let Some(elicitation) = object(&path(key, "elicitation"), map.get("elicitation"), true)? {
        let at = path(key, "elicitation");
        if let Some(form) = object(&path(&at, "form"), elicitation.get("form"), true)? {
            boolean(
                &path(&path(&at, "form"), "applyDefaults"),
                form.get("applyDefaults"),
            )?;
        }
        record(&path(&at, "url"), elicitation.get("url"))?;
    }
    if let Some(roots) = object(&path(key, "roots"), map.get("roots"), true)? {
        boolean(
            &path(&path(key, "roots"), "listChanged"),
            roots.get("listChanged"),
        )?;
    }
    record_of_records(&path(key, "extensions"), map.get("extensions"))
}

/// The first issue of a claimed envelope (`meta` carries [`PROTOCOL_VERSION`]),
/// or `None` when it is valid. The protocol version's value is not checked
/// against the supported revisions here.
pub fn first_issue(meta: &Map<String, Value>) -> Option<EnvelopeIssue> {
    for key in [PROTOCOL_VERSION, CLIENT_CAPABILITIES] {
        if !meta.contains_key(key) {
            return Some(issue(&[key], "missing".into()));
        }
    }
    let check = || -> Check {
        string(&[PROTOCOL_VERSION], meta.get(PROTOCOL_VERSION), false)?;
        implementation(&[CLIENT_INFO], meta.get(CLIENT_INFO))?;
        capabilities(&[CLIENT_CAPABILITIES], meta.get(CLIENT_CAPABILITIES))?;
        match meta.get(LOG_LEVEL) {
            None => Ok(()),
            Some(Value::String(level)) if LOG_LEVELS.contains(&level.as_str()) => Ok(()),
            Some(_) => Err(issue(
                &[LOG_LEVEL],
                format!(
                    "Invalid option: expected one of {}",
                    LOG_LEVELS
                        .iter()
                        .map(|l| format!("\"{l}\""))
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            )),
        }
    };
    check().err()
}
