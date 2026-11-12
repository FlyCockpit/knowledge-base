//! Owner-chosen tool scope of one local stdio session (`kb mcp --root
//! --tools/--kb`), with the server's discovery and authorization rules
//! (tool-scoping plan §§1, 3, 4, 7).
//!
//! * **Discovery** ([`ToolScope::lists`]), computed from the principal's
//!   current [`LiveAuthority`] on every `tools/list`: a grouped tool is listed
//!   when one of its groups is selected, `--read-only` allows it, and the
//!   principal's stored ceiling (plus created-KB bits when it may create)
//!   could ever satisfy the catalog's minimum access. `knowledge_bases_list`
//!   is always listed (no KB names are sent in instructions),
//!   `knowledge_bases_get` whenever a listed tool writes. Order is catalog
//!   order. Each `kbId` is narrowed with an `enum` of the readable KBs that
//!   meet that tool's minimum access (`source.kbId`: read), none above 25.
//! * **Authorization** ([`ToolScope::admit`]): a call is decided by the
//!   scope, never by the list. A grouped tool needs a selected group,
//!   `--read-only` refuses writes, a KB outside `--kb` is `NOT_FOUND`, and
//!   operation-level groups apply (`changes_apply` asset operations need
//!   `assets`; an upload's kind needs `edit` or `assets`, read for
//!   write/finish from stored metadata by [`ToolScope::admit_stored`]).
//!   Supporting tools need no group. The store re-authorizes KB bits.
//!
//! The local store has no grants or elevations; presets only select groups.
use crate::{
    ErrorCode, ToolName,
    schema::{self, MinimumAccess},
    types::{KbId, Permission},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

const ALL_PERMISSIONS: [Permission; 5] = [
    Permission::Read,
    Permission::Propose,
    Permission::Write,
    Permission::Review,
    Permission::Manage,
];

/// A principal's authority as discovery sees it, read fresh for each
/// `tools/list` (calls are re-authorized by the store).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveAuthority {
    /// The store owner: may satisfy owner-only access (delete).
    pub owner: bool,
    /// Expanded union of the principal's stored ceilings in the selection.
    pub ceiling: Vec<Permission>,
    /// Expanded bits a created KB would grant; `None` without a create
    /// capability.
    pub create: Option<Vec<Permission>>,
    /// Selected KBs readable now, with expanded effective bits, sorted by ID.
    /// `None` narrows nothing (every KB, or more than [`ENUM_MAX_KBS`]).
    pub kbs: Option<Vec<(String, Vec<Permission>)>>,
}

impl LiveAuthority {
    /// The store owner: every bit, may create, `kbs` readable now.
    pub fn owner(kbs: Option<Vec<String>>) -> Self {
        Self {
            owner: true,
            ceiling: ALL_PERMISSIONS.to_vec(),
            create: Some(ALL_PERMISSIONS.to_vec()),
            kbs: kbs.map(|kbs| {
                kbs.into_iter()
                    .map(|kb| (kb, ALL_PERMISSIONS.to_vec()))
                    .collect()
            }),
        }
    }
}

/// Live, side-effect-free reads a local session's discovery and
/// pre-handler admission need (the host implements it over its store).
pub trait LiveSource: Send + Sync {
    /// The principal's current authority within `scope`'s selection.
    fn authority(&self, scope: &ToolScope) -> Result<LiveAuthority, ErrorCode>;
    /// The kind of the caller's staged upload, `None` when unknown.
    fn staged_upload_kind(&self, kb: &str, upload: &str) -> Result<Option<String>, ErrorCode>;
}

fn satisfies(access: &MinimumAccess, bits: &[Permission], owner: bool, allow_create: bool) -> bool {
    match access {
        MinimumAccess::Permission(bit) => bits.contains(bit),
        MinimumAccess::OwnerManage => owner && bits.contains(&Permission::Manage),
        MinimumAccess::GlobalAllowCreate => allow_create,
        MinimumAccess::ProposeOrWrite => {
            bits.contains(&Permission::Propose) || bits.contains(&Permission::Write)
        }
        MinimumAccess::SealedGrant => bits.contains(&Permission::Read),
        MinimumAccess::AuthorWithPropose => bits.contains(&Permission::Propose),
        MinimumAccess::AnyOf(of) => of
            .iter()
            .any(|inner| satisfies(inner, bits, owner, allow_create)),
    }
}

/// Above this many KBs no `kbId` is narrowed (the server's enum cap).
pub const ENUM_MAX_KBS: usize = 25;

/// Where a KB ID appears in a tool input (and may be narrowed by an `enum`).
pub(crate) const KB_ID_POINTERS: [&str; 2] =
    ["/properties/kbId", "/properties/source/properties/kbId"];
/// The same two places in a call's arguments.
const KB_ID_ARGUMENTS: [&str; 2] = ["/kbId", "/source/kbId"];

/// What one `--tools` entry selects: its groups, in canonical order.
///
/// Each entry is a tool group (`read`, `edit`, ...) or a preset (`read`,
/// `propose`, `direct`). Both come from the generated protocol artifact.
pub fn parse_tool_selector(entry: &str) -> Result<Vec<&'static str>, String> {
    let entry = entry.trim();
    if let Some(group) = schema::TOOL_GROUPS.iter().find(|group| **group == entry) {
        return Ok(vec![*group]);
    }
    let unavailable = |_| "the tool catalog is unavailable".to_owned();
    if let Some(groups) = schema::preset_groups(entry).map_err(unavailable)? {
        return Ok(groups.to_vec());
    }
    Err(format!(
        "unknown tool group or preset `{entry}` (groups: {}; presets: {})",
        schema::TOOL_GROUPS.join(", "),
        schema::preset_names().map_err(unavailable)?.join(", ")
    ))
}

/// One session's tool groups, write mode and KB selection.
#[derive(Clone, Debug)]
pub struct ToolScope {
    /// Selected groups, de-duplicated, in canonical order; never empty.
    groups: Vec<&'static str>,
    read_only: bool,
    /// The KBs calls may name; `None` is every KB. Shared by clones: a KB
    /// this session creates joins it, as a server grant's ACL gains the KBs
    /// its connection creates.
    kbs: Option<Arc<Mutex<BTreeSet<String>>>>,
}

/// Equal groups, write mode and current KB selection.
impl PartialEq for ToolScope {
    fn eq(&self, other: &Self) -> bool {
        self.groups == other.groups
            && self.read_only == other.read_only
            && self.kbs() == other.kbs()
    }
}

impl ToolScope {
    /// Every group, writes allowed, every KB: the full local catalog.
    pub fn full() -> Self {
        Self {
            groups: schema::TOOL_GROUPS.to_vec(),
            read_only: false,
            kbs: None,
        }
    }

    /// The union of `selected` groups (all groups when empty), `read_only`,
    /// and `kbs` (`None` for every KB).
    pub fn new(selected: &[&'static str], read_only: bool, kbs: Option<&[KbId]>) -> Self {
        let groups = if selected.is_empty() {
            schema::TOOL_GROUPS.to_vec()
        } else {
            schema::TOOL_GROUPS
                .iter()
                .copied()
                .filter(|group| selected.contains(group))
                .collect()
        };
        Self {
            groups,
            read_only,
            kbs: kbs.map(|kbs| {
                Arc::new(Mutex::new(
                    kbs.iter().map(|kb| kb.as_str().to_owned()).collect(),
                ))
            }),
        }
    }

    pub fn groups(&self) -> &[&'static str] {
        &self.groups
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Whether calls are limited to selected KBs.
    pub fn restricts_kbs(&self) -> bool {
        self.kbs.is_some()
    }

    /// Whether a call may name `kb`.
    pub fn allows_kb(&self, kb: &str) -> bool {
        self.kbs.as_ref().is_none_or(|kbs| {
            kbs.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(kb)
        })
    }

    /// The selected KBs, sorted; `None` when every KB is allowed.
    pub fn kbs(&self) -> Option<Vec<String>> {
        self.kbs.as_ref().map(|kbs| {
            kbs.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .cloned()
                .collect()
        })
    }

    fn has_group(&self, group: &str) -> bool {
        self.groups.contains(&group)
    }

    /// The group and write-mode rule shared by discovery and authorization.
    /// An unreadable catalog grants nothing (fail closed).
    fn grants(&self, name: ToolName) -> bool {
        let Ok(groups) = schema::tool_groups(name.as_str()) else {
            return false;
        };
        let grouped = groups.is_empty() || groups.iter().any(|group| self.has_group(group));
        grouped && (!self.read_only || name.read_only())
    }

    /// A tool that belongs to at least one group (not a supporting tool).
    fn grouped(name: ToolName) -> bool {
        schema::tool_groups(name.as_str()).is_ok_and(|groups| !groups.is_empty())
    }

    /// Discovery: whether `tools/list` shows `name` to a principal with
    /// `authority` (the server's rule: groups, write mode, and a ceiling that
    /// could ever satisfy the tool's minimum access).
    pub fn lists(&self, name: ToolName, authority: &LiveAuthority) -> bool {
        let creatable = authority.create.is_some() && !self.read_only && self.has_group("kb_admin");
        let mut ceiling = authority.ceiling.clone();
        if creatable {
            ceiling.extend(authority.create.iter().flatten().copied());
        }
        let listed = |name: ToolName| {
            Self::grouped(name)
                && self.grants(name)
                && schema::tool_minimum_access(name.as_str())
                    .is_ok_and(|access| satisfies(access, &ceiling, authority.owner, creatable))
        };
        match name {
            ToolName::KnowledgeBasesList => true,
            ToolName::KnowledgeBasesGet => ToolName::ALL
                .iter()
                .any(|other| !other.read_only() && listed(*other)),
            _ => listed(name),
        }
    }

    /// Authorization for one schema-checked call, before any handler runs.
    /// Group or write mode refused: `FORBIDDEN`; a KB outside the selection:
    /// `NOT_FOUND` (as for a KB outside a grant); an operation whose group is
    /// not selected: `FORBIDDEN`.
    pub fn admit(&self, name: ToolName, arguments: &Value) -> Result<(), ErrorCode> {
        if !self.grants(name) {
            return Err(ErrorCode::Forbidden);
        }
        for pointer in KB_ID_ARGUMENTS {
            match arguments.pointer(pointer) {
                None => {}
                Some(Value::String(kb)) if self.allows_kb(kb) => {}
                Some(_) => return Err(ErrorCode::NotFound),
            }
        }
        let operation_group = match name {
            ToolName::KnowledgeChangesApply => arguments["changes"]
                .as_array()
                .is_some_and(|changes| {
                    changes.iter().any(|change| {
                        matches!(change["op"].as_str(), Some("assetPut" | "assetRemove"))
                    })
                })
                .then_some("assets"),
            ToolName::KnowledgeUploadBegin => Some(upload_kind_group(
                arguments["kind"].as_str().unwrap_or_default(),
            )),
            _ => None,
        };
        if operation_group.is_some_and(|group| !self.has_group(group)) {
            return Err(ErrorCode::Forbidden);
        }
        Ok(())
    }

    /// An upload write or finish carries the group of its staged kind (the
    /// host looks the kind up; it never changes once staged).
    pub fn admit_upload_kind(&self, kind: &str) -> Result<(), ErrorCode> {
        if self.has_group(upload_kind_group(kind)) {
            Ok(())
        } else {
            Err(ErrorCode::Forbidden)
        }
    }

    /// The stored-metadata part of authorization, run before the handler:
    /// an upload write/finish demands the group of its staged kind (read
    /// side-effect-free through `source`; it never changes once staged).
    pub fn admit_stored(
        &self,
        source: &dyn LiveSource,
        name: ToolName,
        arguments: &Value,
    ) -> Result<(), ErrorCode> {
        if !matches!(
            name,
            ToolName::KnowledgeUploadWrite | ToolName::KnowledgeUploadFinish
        ) || (self.has_group("edit") && self.has_group("assets"))
        {
            return Ok(());
        }
        let field = |key: &str| arguments[key].as_str().unwrap_or_default();
        match source.staged_upload_kind(field("kbId"), field("uploadId"))? {
            Some(kind) => self.admit_upload_kind(&kind),
            None => Ok(()),
        }
    }

    /// The selection as a set, for the store's paginated KB list.
    pub fn kb_set(&self) -> Option<BTreeSet<String>> {
        self.kbs.as_ref().map(|kbs| {
            kbs.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        })
    }

    /// A KB `knowledge_bases_create` returns joins the selection.
    pub fn after_result(&self, name: ToolName, result: Value) -> Value {
        let Some(kbs) = &self.kbs else {
            return result;
        };
        if result["isError"] != json!(false) {
            return result;
        }
        if name == ToolName::KnowledgeBasesCreate
            && let Some(kb) = result
                .pointer("/structuredContent/data/kb/id")
                .and_then(Value::as_str)
        {
            kbs.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(kb.to_owned());
        }
        result
    }

    /// `name`'s pinned input with each KB-ID node narrowed, as the server
    /// narrows it: `kbId` to the readable KBs meeting the tool's minimum
    /// access, `source.kbId` to the readable ones. No narrowing without a
    /// KB list, above [`ENUM_MAX_KBS`], or when no KB qualifies.
    pub(crate) fn narrow_input(name: ToolName, input: &Value, authority: &LiveAuthority) -> Value {
        let mut input = input.clone();
        let Some(kbs) = authority
            .kbs
            .as_ref()
            .filter(|kbs| kbs.len() <= ENUM_MAX_KBS)
        else {
            return input;
        };
        let Ok(access) = schema::tool_minimum_access(name.as_str()) else {
            return input;
        };
        let read = MinimumAccess::Permission(Permission::Read);
        for (pointer, access) in [(KB_ID_POINTERS[0], access), (KB_ID_POINTERS[1], &read)] {
            let Some(Value::Object(node)) = input.pointer_mut(pointer) else {
                continue;
            };
            if node.contains_key("enum") {
                continue;
            }
            let pinned = Value::Object(node.clone());
            let mut ids: Vec<&str> = kbs
                .iter()
                .filter(|(_, bits)| satisfies(access, bits, authority.owner, false))
                .map(|(id, _)| id.as_str())
                .collect();
            ids.sort_unstable();
            ids.dedup();
            let ids: Vec<Value> = ids
                .into_iter()
                .map(|id| json!(id))
                .filter(|id| schema::conforms(&pinned, id))
                .collect();
            if !ids.is_empty() {
                node.insert("enum".to_owned(), Value::Array(ids));
            }
        }
        input
    }
}

/// Markdown uploads belong to `edit`; every other kind to `assets`.
fn upload_kind_group(kind: &str) -> &'static str {
    if kind.eq_ignore_ascii_case("markdown") {
        "edit"
    } else {
        "assets"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stdio::Advertised;

    const FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/protocol/fixtures.json"
    ));
    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";

    fn owner() -> LiveAuthority {
        LiveAuthority::owner(None)
    }

    fn kb(id: &str) -> KbId {
        KbId::parse(id).unwrap()
    }

    fn selected(entries: &[&str]) -> Vec<&'static str> {
        entries
            .iter()
            .flat_map(|entry| parse_tool_selector(entry).unwrap())
            .collect()
    }

    fn listed(scope: &ToolScope) -> Vec<&'static str> {
        Advertised::scoped(scope.clone(), &owner())
            .unwrap()
            .names()
            .iter()
            .map(|name| name.as_str())
            .collect()
    }

    /// Every valid input of every tool in the shared corpus.
    fn corpus() -> Vec<(ToolName, Value)> {
        let fixtures: Value = serde_json::from_str(FIXTURES).unwrap();
        let mut inputs = Vec::new();
        for name in ToolName::ALL {
            let row = &fixtures["tools"][name.as_str()];
            inputs.push((*name, row["validInput"].clone()));
            for variant in row["validInputVariants"].as_array().into_iter().flatten() {
                inputs.push((*name, variant["value"].clone()));
            }
        }
        inputs
    }

    #[test]
    fn selectors_are_groups_or_generated_presets() {
        assert_eq!(parse_tool_selector("edit").unwrap(), ["edit"]);
        assert_eq!(parse_tool_selector("read").unwrap(), ["read"]);
        assert_eq!(
            parse_tool_selector("propose").unwrap(),
            ["read", "edit", "pull_requests"]
        );
        assert_eq!(
            parse_tool_selector(" direct ").unwrap(),
            ["read", "edit", "assets", "pull_requests"]
        );
        let error = parse_tool_selector("admin").unwrap_err();
        assert!(
            error.contains("`admin`") && error.contains("propose"),
            "{error}"
        );
        // Overlapping selections collapse to canonical order.
        let scope = ToolScope::new(&selected(&["sealed", "propose", "read"]), false, None);
        assert_eq!(scope.groups(), ["read", "edit", "pull_requests", "sealed"]);
        assert_eq!(
            ToolScope::new(&[], false, None).groups(),
            schema::TOOL_GROUPS
        );
    }

    #[test]
    fn discovery_is_the_servers_subset_in_catalog_order() {
        let all: Vec<&str> = ToolName::ALL.iter().map(|name| name.as_str()).collect();
        assert_eq!(listed(&ToolScope::full()), all);
        assert_eq!(
            Advertised::local().unwrap().tools(),
            Advertised::scoped(ToolScope::full(), &owner())
                .unwrap()
                .tools()
        );
        // Read: the four read tools plus KB discovery (no names are sent).
        assert_eq!(
            listed(&ToolScope::new(&selected(&["read"]), false, None)),
            [
                "knowledge_bases_list",
                "knowledge_documents_list",
                "knowledge_documents_get",
                "knowledge_search",
                "knowledge_structured_search"
            ]
        );
        // A write group adds the base revision lookup and the shared uploads.
        let direct = listed(&ToolScope::new(&selected(&["direct"]), false, None));
        for tool in [
            "knowledge_bases_get",
            "knowledge_changes_apply",
            "knowledge_upload_begin",
            "knowledge_assets_put",
        ] {
            assert!(direct.contains(&tool), "{tool}");
        }
        // R3-W8: every editing preset follows and closes its own PRs.
        assert!(direct.contains(&"knowledge_pull_requests_list"));
        assert!(
            !listed(&ToolScope::new(&selected(&["edit"]), false, None))
                .contains(&"knowledge_pull_requests_list")
        );
        // --read-only intersects: no write tool, and no revision lookup.
        assert_eq!(
            listed(&ToolScope::new(&selected(&["edit"]), true, None)),
            ["knowledge_bases_list"]
        );
        let reads = listed(&ToolScope::new(&[], true, None));
        assert!(
            reads
                .iter()
                .all(|tool| tool.parse::<ToolName>().unwrap().read_only())
        );
        assert!(!reads.contains(&"knowledge_bases_get"));
        for name in ToolName::ALL {
            let scope = ToolScope::new(&selected(&["propose"]), true, None);
            if scope.lists(*name, &owner()) {
                assert!(name.read_only());
            }
        }
    }

    #[test]
    fn narrowed_lists_pass_the_forwarders_acceptance_rule() {
        let scope = ToolScope::new(&[], false, Some(&[kb(B), kb(A)]));
        let readable = LiveAuthority::owner(Some(vec![B.into(), A.into(), A.into()]));
        let advertised = Advertised::scoped(scope, &readable).unwrap();
        for row in advertised.tools().as_array().unwrap() {
            for pointer in KB_ID_POINTERS {
                if let Some(node) = row["inputSchema"].pointer(pointer) {
                    assert_eq!(node["enum"], json!([A, B]), "{} {pointer}", row["name"]);
                }
            }
        }
        let tools = advertised.tools();
        let import = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "knowledge_assets_import")
            .unwrap();
        assert_eq!(
            import["inputSchema"]["properties"]["source"]["properties"]["kbId"]["enum"],
            json!([A, B])
        );
        // The same subset + narrowed-enum shape a server must send.
        let list = json!({"resultType": "complete", "tools": advertised.tools()});
        let verified = crate::protocol::verify_catalog(list.as_object().unwrap()).unwrap();
        assert_eq!(verified.tools(), advertised.tools());
        // No selection, nothing readable, or above the cap: un-narrowed.
        let many: Vec<String> = (0..=ENUM_MAX_KBS).map(|i| format!("{i:0>24}")).collect();
        let many_ids: Vec<KbId> = many.iter().map(|id| kb(id)).collect();
        for (scope, readable) in [
            (ToolScope::full(), None),
            (ToolScope::new(&[], false, Some(&[kb(A)])), Some(vec![])),
            (ToolScope::new(&[], false, Some(&many_ids)), Some(many)),
        ] {
            assert_eq!(
                Advertised::scoped(scope, &LiveAuthority::owner(readable))
                    .unwrap()
                    .tools(),
                Advertised::local().unwrap().tools()
            );
        }
    }

    #[test]
    fn every_corpus_input_is_decided_by_groups_and_kbs() {
        for (name, input) in corpus() {
            let groups = schema::tool_groups(name.as_str()).unwrap();
            let names_kb = KB_ID_ARGUMENTS
                .iter()
                .any(|pointer| input.pointer(pointer).is_some());
            // Every KB the input names is selected: decided by groups only.
            let mut kbs: Vec<KbId> = KB_ID_ARGUMENTS
                .iter()
                .filter_map(|pointer| input.pointer(pointer)?.as_str().map(kb))
                .collect();
            let all = ToolScope::new(&[], false, Some(&kbs));
            assert_eq!(all.admit(name, &input), Ok(()), "{}", name.as_str());
            // A KB outside the selection, wherever it appears, is not found.
            let other = ToolScope::new(&[], false, Some(&[kb(B)]));
            if names_kb {
                assert_eq!(
                    other.admit(name, &input),
                    Err(ErrorCode::NotFound),
                    "{}",
                    name.as_str()
                );
            }
            for pointer in KB_ID_ARGUMENTS {
                if input.pointer(pointer).is_some() {
                    let mut moved = input.clone();
                    *moved.pointer_mut(pointer).unwrap() = json!(B);
                    kbs.retain(|id| id.as_str() != B);
                    let partial = ToolScope::new(&[], false, Some(&kbs));
                    assert_eq!(
                        partial.admit(name, &moved),
                        Err(ErrorCode::NotFound),
                        "{} {pointer}",
                        name.as_str()
                    );
                }
            }
            // Outside every selected group: refused, whatever the KB.
            for group in schema::TOOL_GROUPS {
                let scope = ToolScope::new(&[group], false, None);
                let granted = groups.is_empty() || groups.contains(group);
                if !granted {
                    assert_eq!(
                        scope.admit(name, &input),
                        Err(ErrorCode::Forbidden),
                        "{} {group}",
                        name.as_str()
                    );
                }
                // Discovery never lists a grouped tool a call would refuse.
                if scope.lists(name, &owner()) && !groups.is_empty() {
                    assert!(granted);
                }
            }
            let read_only = ToolScope::new(&[], true, None);
            assert_eq!(
                read_only.admit(name, &input).is_ok(),
                name.read_only(),
                "{}",
                name.as_str()
            );
        }
    }

    #[test]
    fn operations_carry_their_own_groups() {
        let edit = ToolScope::new(&["edit"], false, None);
        let assets = ToolScope::new(&["assets"], false, None);
        let change = |op: Value| {
            json!({"kbId": A, "baseRevision": "0".repeat(40), "idempotencyKey": "scope-key-000001",
                   "mode": "edit", "changes": [op]})
        };
        let markdown = change(json!({"op": "delete", "path": "a.md"}));
        let asset = change(json!({"op": "assetRemove", "path": "assets/a.png"}));
        assert_eq!(
            edit.admit(ToolName::KnowledgeChangesApply, &markdown),
            Ok(())
        );
        for scope in [&edit, &assets] {
            assert_eq!(
                scope.admit(ToolName::KnowledgeChangesApply, &asset),
                Err(ErrorCode::Forbidden)
            );
        }
        let both = ToolScope::new(&["edit", "assets"], false, None);
        assert_eq!(both.admit(ToolName::KnowledgeChangesApply, &asset), Ok(()));
        let begin = |kind: &str| json!({"kbId": A, "kind": kind});
        assert_eq!(
            edit.admit(ToolName::KnowledgeUploadBegin, &begin("markdown")),
            Ok(())
        );
        assert_eq!(
            edit.admit(ToolName::KnowledgeUploadBegin, &begin("asset")),
            Err(ErrorCode::Forbidden)
        );
        assert_eq!(
            assets.admit(ToolName::KnowledgeUploadBegin, &begin("markdown")),
            Err(ErrorCode::Forbidden)
        );
        assert_eq!(
            assets.admit(ToolName::KnowledgeUploadBegin, &begin("asset")),
            Ok(())
        );
        assert_eq!(edit.admit_upload_kind("asset"), Err(ErrorCode::Forbidden));
        assert_eq!(edit.admit_upload_kind("markdown"), Ok(()));
        assert_eq!(assets.admit_upload_kind("asset"), Ok(()));
    }

    #[test]
    fn results_keep_to_the_selection() {
        let scope = ToolScope::new(&[], false, Some(&[kb(A)]));
        let ok = |data: Value| {
            let envelope = json!({"schemaVersion": "kb/1", "data": data});
            json!({"isError": false, "structuredContent": envelope,
                   "content": [{"type": "text", "text": envelope.to_string()}]})
        };
        // A failed create adds nothing; a created KB joins the selection.
        let failed = json!({"isError": true, "structuredContent": {"data": {"kb": {"id": B}}}});
        scope.after_result(ToolName::KnowledgeBasesCreate, failed);
        assert!(!scope.allows_kb(B));
        let clone = scope.clone();
        scope.after_result(
            ToolName::KnowledgeBasesCreate,
            ok(json!({"kb": {"id": B}, "operationId": "x"})),
        );
        assert!(clone.allows_kb(B));
        assert_eq!(clone.kbs().unwrap(), [A, B]);
    }

    #[test]
    fn capability_principals_are_discovered_by_their_ceilings() {
        use Permission::*;
        let principal = LiveAuthority {
            owner: false,
            ceiling: vec![Read, Propose, Write],
            create: None,
            kbs: Some(vec![
                (A.into(), vec![Read]),
                (B.into(), vec![Read, Propose, Write]),
            ]),
        };
        let advertised = Advertised::scoped(ToolScope::full(), &principal).unwrap();
        let names: Vec<&str> = advertised.names().iter().map(|n| n.as_str()).collect();
        for absent in [
            "knowledge_bases_create",
            "knowledge_bases_update",
            "knowledge_bases_delete",
            "knowledge_index_rebuild",
            "knowledge_embedding_profile_set",
        ] {
            assert!(!names.contains(&absent), "{absent}");
        }
        for present in [
            "knowledge_documents_create",
            "knowledge_pull_requests_review",
            "knowledge_bases_get",
        ] {
            assert!(names.contains(&present), "{present}");
        }
        let rows = advertised.tools();
        let row = |name: &str| {
            rows.as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .unwrap()
                .clone()
        };
        let kb_enum = |name: &str| row(name)["inputSchema"]["properties"]["kbId"]["enum"].clone();
        assert_eq!(kb_enum("knowledge_documents_create"), json!([B]));
        assert_eq!(kb_enum("knowledge_documents_get"), json!([A, B]));
        assert_eq!(kb_enum("knowledge_assets_import"), json!([B]));
        assert_eq!(
            row("knowledge_assets_import")["inputSchema"]["properties"]["source"]["properties"]["kbId"]
                ["enum"],
            json!([A, B])
        );
        // A create capability lists creation, unless writes are off.
        let creator = LiveAuthority {
            create: Some(vec![Read]),
            ..principal.clone()
        };
        assert!(ToolScope::full().lists(ToolName::KnowledgeBasesCreate, &creator));
        assert!(!ToolScope::new(&[], true, None).lists(ToolName::KnowledgeBasesCreate, &creator));
        assert!(
            !ToolScope::new(&["edit"], false, None).lists(ToolName::KnowledgeBasesCreate, &creator)
        );
        // Manage lists update and rebuild; delete stays owner-only.
        let manager = LiveAuthority {
            ceiling: vec![Read, Propose, Write, Review, Manage],
            kbs: Some(vec![(A.into(), vec![Read, Propose, Write, Review, Manage])]),
            ..principal
        };
        let scope = ToolScope::full();
        assert!(scope.lists(ToolName::KnowledgeBasesUpdate, &manager));
        assert!(scope.lists(ToolName::KnowledgeIndexRebuild, &manager));
        assert!(!scope.lists(ToolName::KnowledgeBasesDelete, &manager));
        assert!(scope.lists(ToolName::KnowledgeBasesDelete, &owner()));
        // Read-only ceilings list no write tool and no revision lookup.
        let reader = LiveAuthority {
            owner: false,
            ceiling: vec![Read],
            create: None,
            kbs: Some(vec![(A.into(), vec![Read])]),
        };
        let reads = Advertised::scoped(ToolScope::full(), &reader).unwrap();
        assert!(reads.names().iter().all(|name| name.read_only()));
        assert!(!reads.advertises(ToolName::KnowledgeBasesGet));
    }
}
