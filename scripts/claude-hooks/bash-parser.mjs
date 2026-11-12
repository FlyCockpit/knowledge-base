// Tree-sitter WASM adapter for the Claude Code PreToolUse hook.
// Parses complete Bash source once and walks the CST to executable invocations.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** @typedef {{ raw: string; value?: string; static: boolean; unsupported?: boolean; findPlaceholder?: true; findFollowPlaceholder?: true }} DecodedWord */
/** @typedef {{ id: number; index: number; size: number }} PipelineContext */
/** @typedef {{ scopeId: number; parentScopeId: number | null; executionOwnerScopeIds: number[] }} ScopeOwnership */
/** @typedef {{ scopeId: number; parentScopeId: number | null; executionOwnerScopeIds: number[]; loopIds: number[]; loopOwnerScopeIds: number[][]; loopEntryIds: number[]; quotedHeredocWriterAllowed: boolean }} ExecutionContext */
/** @typedef {{ argv: DecodedWord[]; redirectTargets: DecodedWord[]; source: string; start: number; end: number; pipeline?: PipelineContext; scopeId: number; parentScopeId: number | null; executionOwnerScopeIds: number[]; loopIds: number[]; loopOwnerScopeIds: number[][]; loopEntryIds: number[]; quotedLiteralHeredocWriter?: true }} Invocation */
/** @typedef {{ kind: string; reason: string }} Finding */

export const MAX_BASH_SOURCE_LENGTH = 64_000;
const MAX_AST_NODES = 20_000;

/** @type {import('web-tree-sitter').Parser | null} */
let cachedParser = null;
/** @type {import('web-tree-sitter').Language | null} */
let cachedLanguage = null;
let initPromise = null;

/**
 * Load web-tree-sitter and the bash grammar WASM from installed packages.
 * Fails closed when dependencies are missing.
 */
export async function ensureBashParser() {
  if (cachedParser && cachedLanguage) {
    return { parser: cachedParser, language: cachedLanguage };
  }
  if (!initPromise) {
    initPromise = (async () => {
      const { Parser, Language } = await import("web-tree-sitter");
      await Parser.init();
      const wasmPath = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);
      cachedLanguage = language;
      cachedParser = parser;
    })();
  }
  await initPromise;
  if (!cachedParser || !cachedLanguage) {
    throw new Error("Bash parser failed to initialize.");
  }
  return { parser: cachedParser, language: cachedLanguage };
}

const TRAVERSABLE = new Set([
  "program",
  "list",
  "pipeline",
  "compound_statement",
  "do_group",
  "if_statement",
  "elif_clause",
  "else_clause",
  "while_statement",
  "for_statement",
  "case_statement",
  "case_item",
  "subshell",
  "redirected_statement",
  "negated_command",
  "parenthesized_expression",
  "variable_assignments",
  "c_style_for_statement",
  "binary_expression",
  "unary_expression",
  "ternary_expression",
  "postfix_expression",
]);

const EXECUTABLE = new Set(["command", "test_command"]);

const DENIED = new Set(["function_definition", "process_substitution"]);

/** Data leaves: never executable, but may contain nested substitutions to walk. */
const DATA = new Set([
  "comment",
  "variable_assignment",
  "declaration_command",
  "unset_command",
  "file_redirect",
  "file_descriptor",
  "herestring_redirect",
  "variable_name",
  "word",
  "string",
  "raw_string",
  "concatenation",
  "expansion",
  "simple_expansion",
  "arithmetic_expansion",
  "brace_expression",
  "ansi_c_string",
  "translated_string",
  "string_content",
  "command_name",
  "number",
  "test_operator",
  "special_variable_name",
  "extglob_pattern",
  "regex",
  "array",
  "subscript",
  "select",
  "in",
  "case",
  "do",
  "done",
  "then",
  "else",
  "elif",
  "fi",
  "esac",
  "for",
  "while",
  "until",
  "declare",
  "export",
  "local",
  "readonly",
  "typeset",
  "unset",
  "unsetenv",
]);

const WORD_LIKE = new Set([
  "word",
  "raw_string",
  "string",
  "concatenation",
  "expansion",
  "simple_expansion",
  "command_substitution",
  "brace_expression",
  "ansi_c_string",
  "translated_string",
  "arithmetic_expansion",
  "extglob_pattern",
  "number",
  "regex",
  "array",
  "subscript",
  "special_variable_name",
  "test_operator",
]);

/**
 * @param {import('web-tree-sitter').Node} node
 */
function hasErrorNode(node) {
  if (node.type === "ERROR" || node.type === "MISSING" || node.isMissing) return true;
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child && hasErrorNode(child)) return true;
  }
  return false;
}

/**
 * @param {import('web-tree-sitter').Node} node
 * @param {number} limit
 */
function countNodes(node, limit) {
  let count = 1;
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child) continue;
    count += countNodes(child, limit);
    if (count > limit) return count;
  }
  return count;
}

/**
 * @param {string} text
 * @param {boolean} doubleQuoted
 */
/**
 * True when an unquoted word contains active glob/brace/tilde expansion syntax.
 * Escaped metacharacters (`\*`, `\{`) are literal and do not count.
 *
 * @param {string} text
 */
function hasUnescapedExpansionSyntax(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      if (i + 1 < text.length) i += 1;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "*" || ch === "?" || ch === "[") return true;
    if (ch === "~" && i === 0) return true;
  }
  return false;
}

/**
 * Decode an unquoted Bash word: backslash removes quoting from the next character;
 * backslash-newline disappears.
 *
 * @param {string} text
 */
function decodeUnquotedWord(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    if (i + 1 >= text.length) {
      out += "\\";
      continue;
    }
    const next = text[i + 1];
    if (next === "\n") {
      i += 1;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

function decodeQuotedLiteral(text, doubleQuoted) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    if (i + 1 >= text.length) {
      out += "\\";
      continue;
    }
    const next = text[i + 1];
    if (doubleQuoted) {
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        out += next;
        i += 1;
        continue;
      }
      if (next === "\n") {
        i += 1;
        continue;
      }
      out += "\\";
      out += next;
      i += 1;
      continue;
    }
    if (next === "'") {
      out += "'";
      i += 1;
      continue;
    }
    out += "\\";
    out += next;
    i += 1;
  }
  return out;
}

/**
 * @param {import('web-tree-sitter').Node} node
 * @returns {DecodedWord}
 */
function decodeWordNode(node) {
  switch (node.type) {
    case "word": {
      if (node.text === "\\'" || node.text === "'") {
        return { raw: node.text, value: "'", static: true };
      }
      if (node.text === "{}") {
        return { raw: "{}", value: "{}", static: true };
      }
      if (hasUnescapedExpansionSyntax(node.text)) {
        return { raw: node.text, static: false };
      }
      const value = decodeUnquotedWord(node.text);
      return { raw: node.text, value, static: true };
    }
    case "command_name": {
      const child = node.namedChildren[0];
      if (!child) return { raw: node.text, static: false, unsupported: true };
      return decodeWordNode(child);
    }
    case "raw_string": {
      const inner = decodeQuotedLiteral(node.text.slice(1, -1), false);
      return { raw: node.text, value: inner, static: true };
    }
    case "string": {
      let value = "";
      let dynamic = false;
      let unsupported = false;
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (!child?.isNamed) continue;
        if (child.type === "string_content") {
          value += decodeQuotedLiteral(child.text, true);
          continue;
        }
        if (
          child.type === "expansion" ||
          child.type === "simple_expansion" ||
          child.type === "arithmetic_expansion" ||
          child.type === "command_substitution"
        ) {
          dynamic = true;
          continue;
        }
        unsupported = true;
      }
      if (unsupported || dynamic) {
        return { raw: node.text, static: false, unsupported };
      }
      return { raw: node.text, value, static: true };
    }
    case "concatenation": {
      if (node.text === "{}") {
        return { raw: "{}", value: "{}", static: true };
      }
      /** @type {DecodedWord[]} */
      const parts = [];
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (!child?.isNamed) continue;
        parts.push(decodeWordNode(child));
      }
      if (parts.some((part) => part.unsupported)) {
        return { raw: node.text, static: false, unsupported: true };
      }
      if (parts.some((part) => !part.static)) {
        return { raw: node.text, static: false };
      }
      return {
        raw: node.text,
        value: parts.map((part) => part.value ?? "").join(""),
        static: true,
      };
    }
    case "simple_expansion":
    case "expansion":
    case "arithmetic_expansion":
    case "brace_expression":
    case "extglob_pattern":
    case "process_substitution":
    case "command_substitution":
      return { raw: node.text, static: false };
    case "ansi_c_string":
    case "translated_string":
      return { raw: node.text, static: false, unsupported: true };
    case "number":
      return { raw: node.text, value: node.text, static: true };
    default:
      if (WORD_LIKE.has(node.type)) {
        return { raw: node.text, static: false, unsupported: true };
      }
      return { raw: node.text, static: false, unsupported: true };
  }
}

/**
 * @param {import('web-tree-sitter').Node} node
 * @returns {DecodedWord[]}
 */
function argvFromCommand(node) {
  /** @type {DecodedWord[]} */
  const argv = [];
  const name = node.childForFieldName("name");
  if (name) argv.push(decodeWordNode(name));
  const args = node.childrenForFieldName("argument");
  for (const arg of args) {
    if (arg.type === "redirected_statement" || arg.type === "file_redirect") continue;
    argv.push(decodeWordNode(arg));
  }
  return argv;
}

/**
 * Static file-redirection operands are write targets, not ordinary argv.
 * Preserve their decoded origin beside the invocation so policy consumers do
 * not need to re-tokenize shell source. The one quoted-literal heredoc writer
 * contract below is the only heredoc form that can contribute a target.
 *
 * @param {import('web-tree-sitter').Node} node
 * @returns {DecodedWord[]}
 */
function redirectTargetsFromCommand(node) {
  /** @type {DecodedWord[]} */
  const targets = [];
  const collect = (current) => {
    if (current.type === "file_redirect") {
      const target = current.namedChildren.at(-1);
      targets.push(
        target ? decodeWordNode(target) : { raw: current.text, static: false, unsupported: true },
      );
      return;
    }
    for (const child of current.namedChildren) collect(child);
  };
  collect(node);
  return targets;
}

/**
 * Prove the sole supported heredoc writer without reinterpreting its text:
 * `cat <<'TOKEN' > static-file` or `cat > static-file <<'TOKEN'` (quoted
 * delimiter) with a raw CST body. The grammar makes expansions named children,
 * so a child-free body is literal. Every shape not fully described here remains
 * denied.
 *
 * @param {import('web-tree-sitter').Node} node
 * @param {DecodedWord[]} argv
 * @param {PipelineContext | undefined} pipeline
 * @param {ExecutionContext} context
 */
function isQuotedLiteralCatWriter(node, argv, pipeline, context) {
  if (!context.quotedHeredocWriterAllowed || pipeline || argv.length !== 1) return false;
  if (staticWordValue(argv[0]) !== "cat") return false;
  const heredocs = node.namedChildren.filter((child) => child.type === "heredoc_redirect");
  const redirects = node.namedChildren.filter((child) => child.type === "file_redirect");
  if (heredocs.length !== 1) return false;

  const heredoc = heredocs[0];
  const nestedRedirect = heredoc.namedChildren.find((child) => child.type === "file_redirect");
  /** @type {import('web-tree-sitter').Node | undefined} */
  let redirect;
  if (nestedRedirect && redirects.length === 0) {
    redirect = nestedRedirect;
  } else if (!nestedRedirect && redirects.length === 1) {
    redirect = redirects[0];
  } else {
    return false;
  }

  const start = heredoc.namedChildren.find((child) => child.type === "heredoc_start");
  const body = heredoc.namedChildren.find((child) => child.type === "heredoc_body");
  const end = heredoc.namedChildren.find((child) => child.type === "heredoc_end");
  if (!start || !body || !end || !redirect || body.namedChildCount !== 0) return false;

  const delimiter = start.text;
  if (!/^(['"])[A-Za-z0-9_]+\1$/.test(delimiter)) return false;
  if (end.text !== delimiter.slice(1, -1)) return false;
  if (redirect.child(0)?.text !== ">" || redirect.namedChildCount !== 1) return false;
  return isStaticWord(decodeWordNode(redirect.namedChildren[0]));
}

/**
 * @param {import('web-tree-sitter').Node} node
 */
function childExecutionContext(context, stats, preserveLoops = false, joinsParentOwners = false) {
  const scopeId = stats.nextScopeId++;
  const executionOwnerScopeIds = joinsParentOwners
    ? [scopeId, ...context.executionOwnerScopeIds]
    : [scopeId];
  stats.scopeOwnership.push({
    scopeId,
    parentScopeId: context.scopeId,
    executionOwnerScopeIds,
  });
  return {
    scopeId,
    parentScopeId: context.scopeId,
    executionOwnerScopeIds,
    loopIds: preserveLoops ? context.loopIds : [],
    loopOwnerScopeIds: preserveLoops ? context.loopOwnerScopeIds : [],
    // Child shells cannot change an outer loop owner, but each iteration still
    // starts them from that owner's cwd. Keep entry state separate from the
    // outgoing-effect relation so a later parent `cd` cannot certify a child
    // reset on the next iteration.
    loopEntryIds: context.loopEntryIds,
    quotedHeredocWriterAllowed: context.quotedHeredocWriterAllowed,
  };
}

function walkChildren(
  node,
  source,
  invocations,
  findings,
  stats,
  pipeline,
  context,
  inheritedRedirectTargets = [],
) {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.type !== "command_substitution") continue;
    // A command immediately followed by `&` runs asynchronously in a child
    // shell. Its cwd mutations must not affect the next parent-shell command.
    const isBackgrounded = node.child(i + 1)?.type === "&";
    walkNode(
      child,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      isBackgrounded ? childExecutionContext(context, stats) : context,
      inheritedRedirectTargets,
    );
  }
}

let nextPipelineId = 0;

/**
 * @param {import('web-tree-sitter').Node} node
 * @param {string} source
 * @param {Invocation[]} invocations
 * @param {Finding[]} findings
 * @param {{ nodeCount: number }} stats
 * @param {PipelineContext | undefined} pipeline
 */
function walkNode(
  node,
  source,
  invocations,
  findings,
  stats,
  pipeline,
  context,
  inheritedRedirectTargets = [],
) {
  stats.nodeCount += 1;
  if (stats.nodeCount > MAX_AST_NODES) {
    findings.push({
      kind: "parse-limit",
      reason: `Bash parse tree exceeds the supported node limit (${MAX_AST_NODES}).`,
    });
    return;
  }

  if (node.type === "ERROR" || node.type === "MISSING" || node.isMissing) {
    findings.push({
      kind: "parse-error",
      reason: "Bash source contains a syntax error the hook cannot judge safely.",
    });
    return;
  }

  if (DENIED.has(node.type)) {
    if (node.type === "function_definition") {
      findings.push({
        kind: "shell-function",
        reason:
          "Shell function definitions are outside the supported inline syntax this hook inspects.",
      });
      return;
    }
    findings.push({
      kind: "unsupported-syntax",
      reason: `Unsupported Bash construct \`${node.type}\` is not modeled by this hook.`,
    });
    return;
  }

  if (node.type === "pipeline") {
    /** @type {import('web-tree-sitter').Node[]} */
    const stages = [];
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (!child?.isNamed || child.type === "|") continue;
      stages.push(child);
    }
    const pipelineMeta =
      stages.length > 1 ? { id: nextPipelineId++, size: stages.length } : undefined;
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const stage = stages[stageIndex];
      const childPipeline = pipelineMeta
        ? { id: pipelineMeta.id, index: stageIndex, size: pipelineMeta.size }
        : pipeline;
      walkNode(
        stage,
        source,
        invocations,
        findings,
        stats,
        childPipeline,
        // Pipeline stages normally run in child shells, but Bash's optional
        // `lastpipe` mode can run a final stage in any same-shell owner of its
        // enclosing compound stage. Keep that complete, bounded relation even
        // when the compound itself contains no executable command.
        childExecutionContext(context, stats, true, stageIndex === stages.length - 1),
        inheritedRedirectTargets,
      );
    }
    return;
  }

  if (node.type === "subshell" || node.type === "command_substitution") {
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      childExecutionContext(context, stats),
      // An outer redirect does not redirect command substitution output: it is
      // captured before the enclosing command receives its own redirect.
      node.type === "command_substitution" ? [] : inheritedRedirectTargets,
    );
    return;
  }

  if (
    node.type === "while_statement" ||
    node.type === "for_statement" ||
    node.type === "c_style_for_statement"
  ) {
    const loopId = stats.nextLoopId++;
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      {
        ...context,
        loopIds: [...context.loopIds, loopId],
        loopOwnerScopeIds: [...context.loopOwnerScopeIds, context.executionOwnerScopeIds],
        loopEntryIds: [...context.loopEntryIds, loopId],
        quotedHeredocWriterAllowed: false,
      },
      inheritedRedirectTargets,
    );
    return;
  }

  if (
    node.type === "if_statement" ||
    node.type === "elif_clause" ||
    node.type === "else_clause" ||
    node.type === "case_statement" ||
    node.type === "case_item"
  ) {
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      {
        ...context,
        quotedHeredocWriterAllowed: false,
      },
      inheritedRedirectTargets,
    );
    return;
  }

  // Tree-sitter represents `command > file` as a redirected_statement whose
  // command child has no redirect argument. Keep the redirect target attached
  // to the same invocation rather than falling back to raw source matching.
  if (node.type === "redirected_statement") {
    const command = node.namedChildren.find((child) => EXECUTABLE.has(child.type));
    const redirectTargets = [...inheritedRedirectTargets, ...redirectTargetsFromCommand(node)];
    if (!command) {
      // Redirects can wrap a list, control body, or complete pipeline rather
      // than one simple command. Every child that writes that shared stdout
      // must carry the same target to the policy consumer.
      walkChildren(node, source, invocations, findings, stats, pipeline, context, redirectTargets);
      return;
    }
    const argv = argvFromCommand(command);
    const hasHeredoc = node.namedChildren.some((child) => child.type === "heredoc_redirect");
    const quotedLiteralHeredocWriter = hasHeredoc
      ? isQuotedLiteralCatWriter(node, argv, pipeline, context)
      : false;
    if (hasHeredoc && !quotedLiteralHeredocWriter) {
      findings.push({
        kind: "unsupported-heredoc",
        reason:
          "Only a standalone cat writer with a quoted literal heredoc body and one static overwrite target is supported.",
      });
      return;
    }
    if (argv.length > 0) {
      invocations.push({
        argv,
        redirectTargets,
        source: node.text,
        start: node.startIndex,
        end: node.endIndex,
        pipeline,
        scopeId: context.scopeId,
        parentScopeId: context.parentScopeId,
        executionOwnerScopeIds: context.executionOwnerScopeIds,
        loopIds: context.loopIds,
        loopOwnerScopeIds: context.loopOwnerScopeIds,
        loopEntryIds: context.loopEntryIds,
        ...(quotedLiteralHeredocWriter ? { quotedLiteralHeredocWriter: true } : {}),
      });
    }
    walkChildren(command, source, invocations, findings, stats, pipeline, context, redirectTargets);
    return;
  }

  if (EXECUTABLE.has(node.type)) {
    const argv = argvFromCommand(node);
    if (argv.length > 0) {
      invocations.push({
        argv,
        redirectTargets: [...inheritedRedirectTargets, ...redirectTargetsFromCommand(node)],
        source: node.text,
        start: node.startIndex,
        end: node.endIndex,
        pipeline,
        scopeId: context.scopeId,
        parentScopeId: context.parentScopeId,
        executionOwnerScopeIds: context.executionOwnerScopeIds,
        loopIds: context.loopIds,
        loopOwnerScopeIds: context.loopOwnerScopeIds,
        loopEntryIds: context.loopEntryIds,
      });
    }
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      context,
      inheritedRedirectTargets,
    );
    return;
  }

  if (DATA.has(node.type)) {
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      context,
      inheritedRedirectTargets,
    );
    return;
  }

  if (TRAVERSABLE.has(node.type)) {
    walkChildren(
      node,
      source,
      invocations,
      findings,
      stats,
      pipeline,
      context,
      inheritedRedirectTargets,
    );
    return;
  }

  if (node.isNamed) {
    findings.push({
      kind: "unknown-node",
      reason: `Unknown Bash AST node \`${node.type}\` — the hook denies unclassified syntax.`,
    });
  }
}

/**
 * Parse and walk Bash source.
 *
 * @param {string} source
 * @returns {Promise<{ invocations: Invocation[]; findings: Finding[]; scopeOwnership: ScopeOwnership[]; treeReleased: true }>}
 */
export async function analyzeBashSource(source) {
  if (source.length > MAX_BASH_SOURCE_LENGTH) {
    return {
      invocations: [],
      findings: [
        {
          kind: "parse-limit",
          reason: `Bash input exceeds the supported length limit (${MAX_BASH_SOURCE_LENGTH} bytes).`,
        },
      ],
      scopeOwnership: [{ scopeId: 0, parentScopeId: null, executionOwnerScopeIds: [0] }],
      treeReleased: true,
    };
  }

  const { parser } = await ensureBashParser();
  const tree = parser.parse(source);
  try {
    const root = tree.rootNode;
    if (root?.type !== "program") {
      return {
        invocations: [],
        findings: [
          {
            kind: "parse-error",
            reason: "Bash parser returned no program root.",
          },
        ],
        scopeOwnership: [{ scopeId: 0, parentScopeId: null, executionOwnerScopeIds: [0] }],
        treeReleased: true,
      };
    }
    if (root.hasError || hasErrorNode(root)) {
      return {
        invocations: [],
        findings: [
          {
            kind: "parse-error",
            reason: "Bash source contains a syntax error the hook cannot judge safely.",
          },
        ],
        scopeOwnership: [{ scopeId: 0, parentScopeId: null, executionOwnerScopeIds: [0] }],
        treeReleased: true,
      };
    }
    if (countNodes(root, MAX_AST_NODES) > MAX_AST_NODES) {
      return {
        invocations: [],
        findings: [
          {
            kind: "parse-limit",
            reason: `Bash parse tree exceeds the supported node limit (${MAX_AST_NODES}).`,
          },
        ],
        scopeOwnership: [{ scopeId: 0, parentScopeId: null, executionOwnerScopeIds: [0] }],
        treeReleased: true,
      };
    }

    /** @type {Invocation[]} */
    const invocations = [];
    /** @type {Finding[]} */
    const findings = [];
    const stats = {
      nodeCount: 0,
      nextScopeId: 1,
      nextLoopId: 1,
      scopeOwnership: [{ scopeId: 0, parentScopeId: null, executionOwnerScopeIds: [0] }],
    };
    nextPipelineId = 0;
    walkNode(root, source, invocations, findings, stats, undefined, {
      scopeId: 0,
      parentScopeId: null,
      executionOwnerScopeIds: [0],
      loopIds: [],
      loopOwnerScopeIds: [],
      loopEntryIds: [],
      quotedHeredocWriterAllowed: true,
    });
    return { invocations, findings, scopeOwnership: stats.scopeOwnership, treeReleased: true };
  } finally {
    tree.delete();
  }
}

/** @param {DecodedWord} word */
export function isStaticWord(word) {
  return word.static && word.value !== undefined && !word.unsupported;
}

/** @param {DecodedWord} word @returns {string | null} */
export function staticWordValue(word) {
  return isStaticWord(word) ? (word.value ?? null) : null;
}

/**
 * Static decoded argv values for wrapper resolution. Dynamic or unsupported
 * words keep their raw spelling so callers can fail closed.
 *
 * @param {DecodedWord[]} argv
 * @returns {string[]}
 */
export function argvToTokens(argv) {
  return argv.map((word) => staticWordValue(word) ?? word.raw);
}

/**
 * @param {DecodedWord[]} argv
 * @returns {boolean}
 */
export function argvHasDynamicExecutable(argv) {
  if (argv.length === 0) return false;
  let index = 0;
  while (index < argv.length) {
    const word = argv[index];
    const value = staticWordValue(word);
    if (value !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index += 1;
      continue;
    }
    return !isStaticWord(word);
  }
  return false;
}
