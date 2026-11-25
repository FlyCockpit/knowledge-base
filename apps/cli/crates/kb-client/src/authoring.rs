//! Write modes (`dream` | `edit` | `both`) and document provenance, with the
//! server's rules (`packages/api/src/lib/kb/protocol/catalog.ts`
//! `toolAuthoringNeed`, `parse-markdown.ts` `readDocumentProvenance`).
//!
//! Every write-capable credential has a write mode: `dream` may only write
//! dreams, `edit` may only write directly (documents, assets, uploads, pull
//! requests and merges, KB creation and deletion), `both` may do either. The
//! server enforces it; `kb` narrows a connection locally with the same rules
//! (`kb mcp --write-mode`, a stored login's approved mode, a configured
//! server's `write_mode`). In code the concept is the *authoring mode*.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fmt, str::FromStr};

/// What a call writes: a dream, or a direct edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WriteKind {
    Dream,
    Edit,
}

impl WriteKind {
    /// Wire spelling (`required` of a `WRITE_MODE` refusal).
    pub fn as_str(self) -> &'static str {
        match self {
            WriteKind::Dream => "dream",
            WriteKind::Edit => "edit",
        }
    }
}

/// A credential's write mode: the kinds of writes it may make.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthoringMode {
    Dream,
    Edit,
    Both,
}

impl AuthoringMode {
    pub const ALL: [AuthoringMode; 3] = [
        AuthoringMode::Dream,
        AuthoringMode::Edit,
        AuthoringMode::Both,
    ];

    /// Wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            AuthoringMode::Dream => "dream",
            AuthoringMode::Edit => "edit",
            AuthoringMode::Both => "both",
        }
    }

    /// Whether this mode may make a `kind` write.
    pub fn allows(self, kind: WriteKind) -> bool {
        matches!(
            (self, kind),
            (AuthoringMode::Both, _)
                | (AuthoringMode::Dream, WriteKind::Dream)
                | (AuthoringMode::Edit, WriteKind::Edit)
        )
    }

    /// Whether every write this mode allows, `ceiling` allows too
    /// (`dream`/`edit` are within `both`; `dream` and `edit` are disjoint).
    pub fn within(self, ceiling: AuthoringMode) -> bool {
        [WriteKind::Dream, WriteKind::Edit]
            .into_iter()
            .all(|kind| !self.allows(kind) || ceiling.allows(kind))
    }

    /// The writes both modes allow; `None` when they share none (`dream`
    /// against `edit`).
    pub fn intersect(self, other: AuthoringMode) -> Option<AuthoringMode> {
        let dream = self.allows(WriteKind::Dream) && other.allows(WriteKind::Dream);
        let edit = self.allows(WriteKind::Edit) && other.allows(WriteKind::Edit);
        match (dream, edit) {
            (true, true) => Some(AuthoringMode::Both),
            (true, false) => Some(AuthoringMode::Dream),
            (false, true) => Some(AuthoringMode::Edit),
            (false, false) => None,
        }
    }

    /// The one kind of write this mode allows, `None` for `both`.
    pub fn only(self) -> Option<WriteKind> {
        match self {
            AuthoringMode::Dream => Some(WriteKind::Dream),
            AuthoringMode::Edit => Some(WriteKind::Edit),
            AuthoringMode::Both => None,
        }
    }
}

impl fmt::Display for AuthoringMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for AuthoringMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "dream" => Ok(AuthoringMode::Dream),
            "edit" => Ok(AuthoringMode::Edit),
            "both" => Ok(AuthoringMode::Both),
            other => Err(format!(
                "unknown write mode `{other}` (expected `dream`, `edit` or `both`)"
            )),
        }
    }
}

/// How a catalog tool uses the write mode (`catalog.authoring`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolAuthoring {
    /// Always a direct edit.
    Edit,
    /// The request's `mode`: `dream` is a dream, anything else an edit.
    ByMode,
    /// An edit for the `merge` decision only.
    Merge,
}

impl ToolAuthoring {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "edit" => Some(ToolAuthoring::Edit),
            "by_mode" => Some(ToolAuthoring::ByMode),
            "merge" => Some(ToolAuthoring::Merge),
            _ => None,
        }
    }
}

/// Who wrote a document, from its front matter `provenance`: a dream, an
/// agent (a credential's direct edit, server-stamped) or a person; `Absent`
/// when the document has no label (or a `null` one).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DocumentProvenance {
    Dream,
    Agent,
    Human,
    Absent,
}

impl DocumentProvenance {
    /// The server's `readDocumentProvenance` over the front matter's
    /// `provenance` value (as JSON): any value other than the three labels
    /// reads as `Human` (conservative for dream guards).
    pub fn read(value: Option<&Value>) -> Self {
        match value {
            None | Some(Value::Null) => DocumentProvenance::Absent,
            Some(Value::String(label)) => Self::from_label(label),
            Some(_) => DocumentProvenance::Human,
        }
    }

    /// A string label: `dream`, `agent` and `human` read as themselves,
    /// anything else as `Human`.
    pub fn from_label(label: &str) -> Self {
        match label {
            "dream" => DocumentProvenance::Dream,
            "agent" => DocumentProvenance::Agent,
            _ => DocumentProvenance::Human,
        }
    }

    /// Dreams may update what dreams or agents wrote, never what a person
    /// wrote (or anything unlabelled).
    pub fn is_dream_overwritable(self) -> bool {
        matches!(self, DocumentProvenance::Dream | DocumentProvenance::Agent)
    }

    /// How protected the label is from dreams: dream 0, agent 1, human or
    /// absent 2. A merge of two labels keeps the higher.
    pub fn protection(self) -> u8 {
        match self {
            DocumentProvenance::Dream => 0,
            DocumentProvenance::Agent => 1,
            DocumentProvenance::Human | DocumentProvenance::Absent => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn modes_are_capability_sets() {
        use AuthoringMode::*;
        assert!(Dream.within(Both) && Edit.within(Both) && Both.within(Both));
        assert!(!Both.within(Dream) && !Dream.within(Edit) && !Edit.within(Dream));
        assert_eq!(Dream.intersect(Edit), None);
        assert_eq!(Both.intersect(Edit), Some(Edit));
        assert_eq!(Dream.intersect(Both), Some(Dream));
        assert_eq!(Both.intersect(Both), Some(Both));
        for mode in AuthoringMode::ALL {
            assert_eq!(mode.as_str().parse::<AuthoringMode>(), Ok(mode));
            assert_eq!(
                serde_json::to_value(mode).unwrap(),
                json!(mode.as_str()),
                "{mode}"
            );
        }
        assert!("all".parse::<AuthoringMode>().is_err());
        assert_eq!(Both.only(), None);
        assert_eq!(Dream.only(), Some(WriteKind::Dream));
    }

    #[test]
    fn provenance_reads_like_the_server() {
        use DocumentProvenance::*;
        let read = |v: Value| DocumentProvenance::read(Some(&v));
        assert_eq!(read(json!("dream")), Dream);
        assert_eq!(read(json!("agent")), Agent);
        assert_eq!(read(json!("human")), Human);
        assert_eq!(read(json!("robot")), Human);
        assert_eq!(read(json!(["agent"])), Human);
        assert_eq!(read(Value::Null), Absent);
        assert_eq!(DocumentProvenance::read(None), Absent);
        assert_eq!(
            [Dream, Agent, Human, Absent].map(DocumentProvenance::is_dream_overwritable),
            [true, true, false, false]
        );
        assert_eq!(
            [Dream, Agent, Human, Absent].map(DocumentProvenance::protection),
            [0, 1, 2, 2]
        );
    }
}
