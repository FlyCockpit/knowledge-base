/**
 * Structural destructive-operation scanner used by scripts/policy-checks.sh.
 *
 * The shell gate owns candidate enumeration, mention-vs-execution handling,
 * and exact reviewed-occurrence filtering. This helper owns two syntactic
 * classes that are not safe to decide with a line regex:
 *
 * - literal Prisma `deleteMany` calls with no effective `where` predicate;
 * - statement-anchored raw SQL `DELETE FROM` without `WHERE`, `TRUNCATE`, and
 *   `DROP TABLE|DATABASE|SCHEMA` (including across newlines). English phrases
 *   such as "delete from the list" are not statements.
 *
 * Dynamic arguments and dynamic SQL are deliberately outside this helper's
 * finite static scope. They are not classified as safe; this scanner only
 * makes the literal empty forms impossible to hide behind whitespace,
 * comments, line breaks, identifiers, or quoted `WHERE` text.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";

const { parse } = createRequire(import.meta.url)("@babel/parser");
const { analyzeBashSource, ensureBashParser, isStaticWord, staticWordValue } = await import(
  "./claude-hooks/bash-parser.mjs"
);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const JSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const RAW_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".json",
  ".jsonl",
  ".yml",
  ".yaml",
  ".toml",
  ".sql",
]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const JAVASCRIPT_INTERPRETERS = new Set(["node", "bun", "tsx"]);
const DIRECT_INTERPRETER_PATHS = new Set(
  [...JAVASCRIPT_INTERPRETERS, ...SHELL_INTERPRETERS].flatMap((interpreter) => [
    interpreter,
    `/bin/${interpreter}`,
    `/usr/bin/${interpreter}`,
  ]),
);
const ENV_INTERPRETERS = new Set(["node", "bash"]);

/** @param {string} path */
function sourceExtension(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot) : "";
}

/** @param {unknown} value */
function node(value) {
  return typeof value === "object" && value !== null && "type" in value ? value : undefined;
}

/** @param {unknown} value @param {boolean} computed */
function staticPropertyName(value, computed = false) {
  const current = node(value);
  if (!current) return undefined;
  if ((current.type === "Identifier" || current.type === "JSXIdentifier") && !computed) {
    return current.name;
  }
  if (current.type === "StringLiteral") return current.value;
  return undefined;
}

/** @param {unknown} value */
function unwrapExpression(value) {
  let current = node(value);
  while (
    current &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSInstantiationExpression",
      "ParenthesizedExpression",
      "ChainExpression",
    ].includes(current.type)
  ) {
    current = node(current.expression);
  }
  return current;
}

/** @param {unknown} value */
function isEmptyObject(value) {
  const current = unwrapExpression(value);
  return current?.type === "ObjectExpression" && current.properties.length === 0;
}

/**
 * `deleteMany()` and `deleteMany({})` have no predicate. A literal
 * `deleteMany({ where: {} })` is also unqualified even when comments/newlines
 * surround the empty object. Dynamic values are intentionally not inferred.
 *
 * @param {unknown[]} args
 */
function hasLiteralEmptyDeleteManyQualifier(args) {
  if (args.length === 0) return true;
  if (args.length !== 1) return false;
  const options = unwrapExpression(args[0]);
  // Passing `undefined` (including `void 0`) as the sole argument is the
  // same no-options call at runtime. `null` is not included: Prisma may reject
  // it before any delete, so this finite policy does not claim it destructive.
  if (
    (options?.type === "Identifier" && options.name === "undefined") ||
    (options?.type === "UnaryExpression" && options.operator === "void")
  ) {
    return true;
  }
  if (options?.type !== "ObjectExpression") return false;
  if (options.properties.length === 0) return true;
  let whereState = "absent";
  for (const property of options.properties) {
    // A spread may provide or overwrite `where`; it is unclassified unless a
    // later static `where` property proves the final literal value.
    if (property.type === "SpreadElement") {
      whereState = "unknown";
      continue;
    }
    if (property.type !== "ObjectProperty") {
      continue;
    }
    const name = staticPropertyName(property.key, property.computed);
    if (name === undefined) {
      whereState = "unknown";
      continue;
    }
    if (name !== "where") continue;
    const value = unwrapExpression(property.value);
    whereState =
      isEmptyObject(value) ||
      value?.type === "NullLiteral" ||
      (value?.type === "Identifier" && value.name === "undefined") ||
      (value?.type === "UnaryExpression" && value.operator === "void")
        ? "empty"
        : "nonempty";
  }
  // A literal options object with no `where` is a no-predicate call even when
  // it carries another option. `undefined`, `void 0`, `null`, and `{}` are the
  // finite literal spellings that likewise supply no predicate. Dynamic
  // spreads/computed keys are deliberately unclassified rather than guessed.
  return whereState === "absent" || whereState === "empty";
}

/** @param {string} source @param {number} start @param {number} end */
function unwrapQuotedRange(source, start, end) {
  if (end - start < 2) return { start, end };
  const open = source[start] ?? "";
  const close = source[end - 1] ?? "";
  if ((open === '"' || open === "'" || open === "`") && open === close) {
    return { start: start + 1, end: end - 1 };
  }
  return { start, end };
}

/** @param {string} source @param {number} start @param {number} end */
function sqlLiteralHits(source, start, end) {
  const range = unwrapQuotedRange(source, start, end);
  return sqlDestructiveStatementHits(source, range.start, range.end).map((offset) =>
    lineAt(source, offset),
  );
}

/** @param {unknown} value @param {string} source @param {Array<{ line: number; column: number }>} hits */
function walk(value, source, hits, parent) {
  const current = node(value);
  if (!current) return;
  if (current.type === "CallExpression" || current.type === "OptionalCallExpression") {
    const callee = unwrapExpression(current.callee);
    if (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") {
      if (
        staticPropertyName(callee.property, callee.computed) === "deleteMany" &&
        hasLiteralEmptyDeleteManyQualifier(current.arguments)
      ) {
        hits.push({ line: current.loc.start.line, column: current.loc.start.column });
      }
    }
  }
  if (
    current.type === "StringLiteral" &&
    !(parent?.type === "JSXAttribute" && staticPropertyName(parent.name) === "className")
  ) {
    for (const line of sqlLiteralHits(source, current.start, current.end)) {
      hits.push({ line, column: current.loc.start.column });
    }
  }
  if (current.type === "TemplateLiteral" && current.expressions.length === 0) {
    for (const line of sqlLiteralHits(source, current.start, current.end)) {
      hits.push({ line, column: current.loc.start.column });
    }
  }
  for (const child of Object.values(current)) {
    if (Array.isArray(child)) {
      for (const item of child) walk(item, source, hits, current);
    } else {
      walk(child, source, hits, current);
    }
  }
}

/** @param {string} source @param {string} path */
function shebangInterpreter(source, path) {
  const line = source.split("\n", 1)[0] ?? "";
  if (!line.startsWith("#!")) return undefined;
  const words = line
    .slice(2)
    .trim()
    .split(/[ \t]+/)
    .filter(Boolean);
  if (words.length === 0) {
    throw new Error(`cannot classify destructive-policy candidate ${path}: empty shebang`);
  }
  const [command, ...args] = words;
  if (command === "/usr/bin/env") {
    // Only the ordinary POSIX env form used by this repository is supported.
    // `env -S`, option forms, assignments, extra runtime arguments, and an
    // unknown runtime can change execution semantics, so they are not guessed.
    if (args.length === 1 && ENV_INTERPRETERS.has(args[0] ?? "")) return args[0];
    throw new Error(
      `cannot classify destructive-policy candidate ${path}: unsupported /usr/bin/env shebang form`,
    );
  }
  if (args.length === 0 && DIRECT_INTERPRETER_PATHS.has(command)) {
    return command.slice(command.lastIndexOf("/") + 1);
  }
  throw new Error(
    `cannot classify destructive-policy candidate ${path}: unsupported shebang interpreter or argument mode`,
  );
}

/** @param {string} path */
function isDockerfile(path) {
  return basename(path).startsWith("Dockerfile");
}

/**
 * Every candidate accepted by policy-checks has a finite scanner class. The
 * collector intentionally includes extensionless direct automation roots, so
 * an unlabelled file is never silently treated as harmless text: it must carry
 * a supported JS/TS extension, a known interpreter shebang, or a recognized
 * shell/config/data identity. Other executable/source languages fail closed.
 *
 * @param {string} source
 * @param {string} path
 */
function classifyCandidate(source, path) {
  const extension = sourceExtension(path).toLowerCase();
  const suffixClass = SOURCE_EXTENSIONS.has(extension)
    ? "javascript"
    : RAW_EXTENSIONS.has(extension) || isDockerfile(path)
      ? "raw"
      : undefined;
  const interpreter = shebangInterpreter(source, path);
  const headerClass = interpreter
    ? JAVASCRIPT_INTERPRETERS.has(interpreter)
      ? "javascript"
      : "raw"
    : undefined;
  if (suffixClass && headerClass && suffixClass !== headerClass) {
    throw new Error(
      `cannot classify destructive-policy candidate ${path}: suffix and shebang interpreter disagree`,
    );
  }
  // JavaScript source can intentionally contain a NUL string literal. Other
  // supported scanner classes are text formats, so a NUL there is opaque
  // binary input rather than a safely inspectable shell/config/data candidate.
  if (source.includes("\0") && headerClass !== "javascript" && suffixClass !== "javascript") {
    throw new Error(`cannot classify destructive-policy candidate ${path}: binary content`);
  }
  if (headerClass) return headerClass;
  if (suffixClass) return suffixClass;
  throw new Error(
    `cannot classify destructive-policy candidate ${path}: use a supported JS/TS extension, a Node/Bun/tsx or shell shebang, or a recognized shell/config/data extension`,
  );
}

function literalOperationHits(source, path) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins: JSX_EXTENSIONS.has(sourceExtension(path).toLowerCase())
        ? ["typescript", "jsx"]
        : ["typescript"],
    });
  } catch (error) {
    throw new Error(
      `cannot parse ${path} for literal destructive-operation policy: ${error.message}`,
    );
  }
  const hits = [];
  walk(ast, source, hits);
  return hits;
}

/** @param {string} path */
function isJavaScriptSource(path) {
  return SOURCE_EXTENSIONS.has(sourceExtension(path).toLowerCase());
}

/** @param {unknown} value */
function identifierName(value) {
  const current = node(value);
  return current?.type === "Identifier" ? current.name : undefined;
}

/** @param {unknown} value */
function staticKeyName(value) {
  const current = node(value);
  if (!current) return undefined;
  if (current.type === "Identifier") return current.name;
  if (current.type === "StringLiteral") return current.value;
  return undefined;
}

/** @param {unknown[]} ancestors @param {string} name */
function hasNamedFunction(ancestors, name) {
  return ancestors.some((ancestor) => {
    const current = node(ancestor);
    return (
      (current?.type === "FunctionDeclaration" || current?.type === "FunctionExpression") &&
      identifierName(current.id) === name
    );
  });
}

/** @param {unknown} value */
function isLiteralWithoutEvaluation(value) {
  const current = node(value);
  if (current?.type === "StringLiteral") return true;
  if (current?.type === "TemplateLiteral") return current.expressions.length === 0;
  if (current?.type !== "TaggedTemplateExpression" || current.quasi.expressions.length !== 0) {
    return false;
  }
  const tag = node(current.tag);
  return (
    tag?.type === "MemberExpression" &&
    identifierName(tag.object) === "String" &&
    staticPropertyName(tag.property, tag.computed) === "raw"
  );
}

/** @param {unknown} tuple @param {number} width @param {unknown} literal */
function isLiteralFixtureTuple(tuple, width, literal) {
  const current = node(tuple);
  if (
    current?.type !== "ArrayExpression" ||
    current.elements.length !== width ||
    !isLiteralWithoutEvaluation(literal)
  ) {
    return false;
  }
  if (width === 2) {
    return current.elements[0] === literal && node(current.elements[1])?.type === "BooleanLiteral";
  }
  const expected = node(current.elements[2]);
  return (
    current.elements.includes(literal) &&
    node(current.elements[0])?.type === "StringLiteral" &&
    node(current.elements[1])?.type === "StringLiteral" &&
    expected?.type === "StringLiteral" &&
    ["destructive", "risky", "clean"].includes(expected.value)
  );
}

/** @param {unknown[]} ancestors @param {string[]} names */
function isDirectFixtureTableEntry(ancestors, names) {
  const tuple = node(ancestors.at(-1));
  const carrier = node(ancestors.at(-2));
  if (!tuple || !carrier) return false;
  if (carrier.type === "ArrayExpression") {
    const declaration = node(ancestors.at(-3));
    return (
      declaration?.type === "VariableDeclarator" &&
      names.includes(identifierName(declaration.id) ?? "") &&
      declaration.init === carrier &&
      carrier.elements.includes(tuple)
    );
  }
  if (carrier.type !== "CallExpression") return false;
  const callee = node(carrier.callee);
  return (
    callee?.type === "MemberExpression" &&
    names.includes(identifierName(callee.object) ?? "") &&
    staticPropertyName(callee.property, callee.computed) === "push" &&
    carrier.arguments.includes(tuple)
  );
}

/** @param {string} path @param {unknown} current @param {unknown[]} ancestors */
function isHookSelfTestCase(path, current, ancestors) {
  // Closed parser-fixture grammar: a literal source value is the first member
  // of a [command, expected-denial] tuple inserted directly into the hook's
  // self-test tables. No computed expression or executor may intervene.
  if (
    path !== "scripts/claude-hooks/pre-tool-use.mjs" ||
    !hasNamedFunction(ancestors, "selfTest") ||
    !isLiteralWithoutEvaluation(current)
  ) {
    return false;
  }
  const tuple = node(ancestors.at(-1));
  return (
    isLiteralFixtureTuple(tuple, 2, current) &&
    isDirectFixtureTableEntry(ancestors, ["bashCases", "c24BashCases"])
  );
}

/** @param {string} path @param {unknown} current @param {unknown[]} ancestors */
function isBashRuleInertLiteral(path, current, ancestors) {
  if (path !== "scripts/claude-hooks/pre-tool-use.mjs" || !isLiteralWithoutEvaluation(current)) {
    return false;
  }
  const property = node(ancestors.at(-1));
  const rule = node(ancestors.at(-2));
  const rules = node(ancestors.at(-3));
  const declaration = node(ancestors.at(-4));
  if (
    property?.type !== "ObjectProperty" ||
    !["name", "reason"].includes(staticKeyName(property.key) ?? "") ||
    property.value !== current ||
    rule?.type !== "ObjectExpression" ||
    !rule.properties.includes(property) ||
    rules?.type !== "ArrayExpression" ||
    !rules.elements.includes(rule) ||
    declaration?.type !== "VariableDeclarator" ||
    identifierName(declaration.id) !== "BASH_RULES" ||
    declaration.init !== rules
  ) {
    return false;
  }
  return (
    rule.properties.some(
      (entry) =>
        node(entry)?.type === "ObjectProperty" &&
        staticKeyName(node(entry).key) === "name" &&
        node(node(entry).value)?.type === "StringLiteral",
    ) && rule.properties.some((entry) => staticKeyName(node(entry)?.key) === "test")
  );
}

/** @param {unknown} current @param {unknown[]} ancestors */
function isDirectConsoleDisplayLiteral(current, ancestors) {
  if (!isLiteralWithoutEvaluation(current)) return false;
  const display = node(ancestors.at(-1));
  const statement = node(ancestors.at(-2));
  const callee = display && node(display.callee);
  return (
    display?.type === "CallExpression" &&
    display.arguments.includes(current) &&
    callee?.type === "MemberExpression" &&
    identifierName(callee.object) === "console" &&
    ["log", "error", "warn", "info"].includes(
      staticPropertyName(callee.property, callee.computed),
    ) &&
    statement?.type === "ExpressionStatement" &&
    statement.expression === display
  );
}

/** @param {string} path @param {unknown} current @param {unknown[]} ancestors */
function isHookDenyParserLiteral(path, current, ancestors) {
  if (path !== "scripts/claude-hooks/pre-tool-use.mjs" || !isLiteralWithoutEvaluation(current)) {
    return false;
  }
  const parent = node(ancestors.at(-1));
  if (parent?.type === "BinaryExpression") {
    const receiver = node(parent.left);
    return (
      ["===", "!=="].includes(parent.operator) &&
      parent.right === current &&
      (identifierName(receiver) === "arg" ||
        (receiver?.type === "MemberExpression" &&
          identifierName(receiver.object) === "word" &&
          staticPropertyName(receiver.property, receiver.computed) === "value"))
    );
  }
  if (parent?.type !== "CallExpression" && parent?.type !== "OptionalCallExpression") return false;
  const callee = node(parent.callee);
  const receiver = callee && node(callee.object);
  return (
    parent.arguments.includes(current) &&
    (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
    staticPropertyName(callee.property, callee.computed) === "startsWith" &&
    (identifierName(receiver) === "arg" ||
      ((receiver?.type === "MemberExpression" || receiver?.type === "OptionalMemberExpression") &&
        identifierName(receiver.object) === "word" &&
        staticPropertyName(receiver.property, receiver.computed) === "value"))
  );
}

/**
 * A marker may document only a value whose enclosing AST establishes that it is
 * inert. This deliberately does not attempt arbitrary data-flow analysis.
 * Values assigned to unknown variables, arrays, object fields, templates,
 * regexes, or later executor calls are live unless they fit one finite proof
 * below.
 *
 * @param {unknown} current
 * @param {unknown[]} ancestors
 */
function isProvenInertAuditedLiteral(current, path, ancestors) {
  return (
    isDirectConsoleDisplayLiteral(current, ancestors) ||
    isBashRuleInertLiteral(path, current, ancestors) ||
    isHookDenyParserLiteral(path, current, ancestors) ||
    isHookSelfTestCase(path, current, ancestors)
  );
}

/** @param {string} source @param {string} path @param {number} line */
function javascriptAuditedContext(source, path, line) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins: JSX_EXTENSIONS.has(sourceExtension(path).toLowerCase())
        ? ["typescript", "jsx"]
        : ["typescript"],
    });
  } catch (error) {
    throw new Error(`cannot parse ${path} for audited destructive context: ${error.message}`);
  }
  const candidates = [];
  const visit = (value, ancestors = [], parent) => {
    const current = node(value);
    if (!current) return;
    const spansLine = current.loc && current.loc.start.line <= line && line <= current.loc.end.line;
    if (
      spansLine &&
      (current.type === "StringLiteral" ||
        (current.type === "TemplateLiteral" && parent?.type !== "TaggedTemplateExpression") ||
        current.type === "TaggedTemplateExpression" ||
        current.type === "RegExpLiteral")
    ) {
      candidates.push({ current, ancestors });
    }
    for (const child of Object.values(current)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item, [...ancestors, current], current);
      } else {
        visit(child, [...ancestors, current], current);
      }
    }
  };
  visit(ast);
  return candidates.length > 0 &&
    candidates.every(({ current, ancestors }) =>
      isProvenInertAuditedLiteral(current, path, ancestors, source),
    )
    ? "mention"
    : "live";
}

/** @param {import('web-tree-sitter').Node} value */
function staticDetectorLiteral(value) {
  if (value.type === "raw_string") return value.namedChildCount === 0;
  if (value.type === "string") {
    return value.namedChildren.every((child) => child.type === "string_content");
  }
  if (value.type === "concatenation") {
    return value.namedChildren.length > 0 && value.namedChildren.every(staticDetectorLiteral);
  }
  return false;
}

/** @param {import('web-tree-sitter').Node} value */
function detectorAggregateLiteral(value) {
  const expansions = value.namedChildren.filter((child) => child.type === "simple_expansion");
  return (
    value.type === "string" &&
    value.namedChildren.length > 0 &&
    value.namedChildren.every(
      (child) =>
        child.type === "string_content" ||
        (child.type === "simple_expansion" &&
          child.namedChildCount === 1 &&
          ["DESTRUCTIVE_RE", "DELETE_RE"].includes(child.namedChildren[0]?.text ?? "")),
    ) &&
    expansions.length === 2 &&
    expansions
      .map((child) => child.namedChildren[0]?.text)
      .sort()
      .join(",") === "DELETE_RE,DESTRUCTIVE_RE"
  );
}

/**
 * The policy's scanner regexes are the only assignment data that receive the
 * mention classification. Their assignments are parsed as a complete Bash
 * program and their right sides have a closed grammar. The aggregate may refer
 * only to the two static detector values; substitutions, command lists,
 * redirects, and unrelated assignments are not members of this class.
 *
 * @param {string} source
 * @param {number} line
 */
async function isExactPolicyDetectorAssignment(source, line) {
  const { parser } = await ensureBashParser();
  const tree = parser.parse(source);
  try {
    const root = tree.rootNode;
    if (!root || root.hasError) return false;
    const assignments = [];
    const collect = (current) => {
      if (current.type === "variable_assignment") assignments.push(current);
      for (const child of current.namedChildren) collect(child);
    };
    collect(root);
    const onLine = assignments.filter((assignment) => assignment.startPosition.row + 1 === line);
    if (onLine.length !== 1) return false;
    const assignment = onLine[0];
    const name = assignment.childForFieldName("name")?.text;
    const value = assignment.childForFieldName("value");
    if (!name || !value || !["DESTRUCTIVE_RE", "DELETE_RE", "AUDIT_MATCH_RE"].includes(name)) {
      return false;
    }
    // The owner is a unique top-level assignment. A command-scoped environment
    // assignment such as `AUDIT_MATCH_RE="$AUDIT_MATCH_RE" awk ...` is a
    // consumer, not a second regex definition; it cannot receive this grant.
    const owners = assignments.filter(
      (candidate) =>
        candidate.childForFieldName("name")?.text === name && candidate.parent?.type === "program",
    );
    if (assignment.parent?.type !== "program" || owners.length !== 1 || owners[0] !== assignment) {
      return false;
    }
    const statement = root.namedChildren.filter(
      (candidate) => candidate.startPosition.row + 1 === line,
    );
    if (
      statement.length === 0 ||
      !statement.includes(assignment) ||
      statement.some((candidate) => candidate !== assignment && candidate.type !== "comment")
    ) {
      return false;
    }
    return name === "AUDIT_MATCH_RE"
      ? detectorAggregateLiteral(value)
      : staticDetectorLiteral(value);
  } finally {
    tree.delete();
  }
}

/** @param {string} source @param {number} start @param {number} end */
function hasOnlyDirectDisplayLineContext(source, start, end) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextLineStart = source.indexOf("\n", lineStart);
  const lineEnd = nextLineStart === -1 ? source.length : nextLineStart;
  const startsHere = start >= lineStart && start <= lineEnd;
  const endsHere = end >= lineStart && end <= lineEnd;
  // The scanner currently supplies a physical line, rather than a match
  // column. Requiring the actual root command to own every non-comment byte on
  // that line prevents a destructive assignment/command sibling from borrowing
  // an unrelated `echo` or `printf` that happens to share its line.
  if (startsHere && !/^\s*$/.test(source.slice(lineStart, start))) return false;
  // A command that continues onto a later physical line cannot have a sibling
  // after the marked value's line. When it ends here, permit only whitespace
  // and a comment; `;`, `&&`, `|`, or another command is therefore live.
  return !endsHere || /^\s*(?:#.*)?$/.test(source.slice(end, lineEnd));
}

/**
 * Grant a shell display marker only after the complete source places its
 * actual `command` node directly under `program`. This is the deliberately
 * finite output-consumer boundary: a root command has no enclosing command,
 * substitution, pipeline, redirect wrapper, compound statement, function,
 * subshell, control body, or heredoc carrier that can capture or redirect its
 * stdout. We do not infer later variable flow or builtin behavior.
 *
 * `analyzeBashSource` is used only to decode the exact bytes of that already
 * located raw CST command and retain the existing static `echo` / `printf`
 * argv grammar. It is not used as evidence of the command's containment.
 *
 * @param {string} source
 * @param {number} line
 */
async function isFullSourceStandaloneDisplayInvocation(source, line) {
  const { parser } = await ensureBashParser();
  const tree = parser.parse(source);
  try {
    const root = tree.rootNode;
    if (root?.type !== "program" || root.hasError) return false;

    const commands = [];
    const collect = (current) => {
      if (current.type === "command") commands.push(current);
      for (const child of current.namedChildren) collect(child);
    };
    collect(root);
    const candidates = commands.filter(
      (command) =>
        command.parent?.type === "program" &&
        command.startPosition.row + 1 <= line &&
        line <= command.endPosition.row + 1,
    );
    if (candidates.length !== 1) return false;
    const command = candidates[0];
    if (
      !command ||
      !hasOnlyDirectDisplayLineContext(source, command.startIndex, command.endIndex)
    ) {
      return false;
    }

    const analysis = await analyzeBashSource(command.text);
    if (analysis.findings.length !== 0 || analysis.invocations.length !== 1) return false;
    const invocation = analysis.invocations[0];
    if (
      !invocation ||
      invocation.pipeline ||
      invocation.redirectTargets.length !== 0 ||
      invocation.scopeId !== 0 ||
      invocation.loopIds.length !== 0 ||
      invocation.argv.some((word) => !isStaticWord(word))
    ) {
      return false;
    }
    const argv = invocation.argv.map(staticWordValue);
    if (argv[0] === "echo") return argv.length >= 2;
    // `%s\\n` plus exactly one static value is the complete printf display form;
    // accepting generic printf options would admit assignment/output variants.
    return argv.length === 3 && argv[0] === "printf" && argv[1] === "%s\\n";
  } finally {
    tree.delete();
  }
}

/** @param {string} path @param {string} source @param {number} line */
async function shellAuditedContext(path, source, line) {
  if (
    path === "scripts/policy-checks.sh" &&
    (await isExactPolicyDetectorAssignment(source, line))
  ) {
    return "mention";
  }
  return (await isFullSourceStandaloneDisplayInvocation(source, line)) ? "mention" : "live";
}

/** @param {string} path @param {number} line */
async function auditedContext(path, line) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path} for audited destructive context: ${error.message}`);
  }
  if (isJavaScriptSource(path)) return javascriptAuditedContext(source, path, line);
  if (isLocaleJsonPath(path)) return "mention";
  if (path.endsWith(".sql")) return sqlAuditedContext(source, line);
  if (
    path.endsWith(".yml") ||
    path.endsWith(".yaml") ||
    path.endsWith(".json") ||
    path.endsWith(".jsonl")
  ) {
    return "live";
  }
  return shellAuditedContext(path, source, line);
}

/** @param {string} path */
function isLocaleJsonPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return /(^|\/)packages\/locales\/.+\.json$/.test(normalized);
}

/** @param {string} source @param {number} line */
function sqlAuditedContext(source, line) {
  const text = lineTextAt(source, line);
  if (/^\s*--/.test(text)) return "mention";
  if (/^\s*\/\*/.test(text) && (text.includes("*/") ? /^\s*\/\*.*\*\/\s*$/.test(text) : true)) {
    return "mention";
  }
  return "live";
}

function isWordStart(character) {
  return /[A-Za-z_]/.test(character);
}

function isWordPart(character) {
  return /[A-Za-z0-9_$]/.test(character);
}

/**
 * Skip whitespace and SQL `--` / `/*` comments. Used to find the next
 * statement start so English "delete from the list" is not a statement.
 *
 * @param {string} source
 * @param {number} index
 * @param {number} end
 */
function skipSqlTrivia(source, index, end) {
  while (index < end) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < end && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index + 1 < end && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, end);
      continue;
    }
    break;
  }
  return index;
}

/**
 * Scan one SQL-shaped statement following a `DELETE FROM` token. SQL strings,
 * quoted identifiers, and line/block comments never become a predicate. A
 * semicolon ends this statement, so a later qualified sibling cannot excuse
 * an earlier unqualified one.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function sqlStatementHasWhere(source, start, end) {
  let index = start;
  let state = "code";
  let hasWhere = false;
  while (index < end) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") {
        index += 2;
      } else if (character === "'") {
        state = "code";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "double-quote") {
      if (character === '"' && next === '"') {
        index += 2;
      } else if (character === '"') {
        state = "code";
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (character === ";") return hasWhere;
    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 2;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      index += 1;
      continue;
    }
    if (isWordStart(character)) {
      let wordEnd = index + 1;
      while (wordEnd < end && isWordPart(source[wordEnd] ?? "")) wordEnd += 1;
      if (source.slice(index, wordEnd).toUpperCase() === "WHERE") hasWhere = true;
      index = wordEnd;
      continue;
    }
    index += 1;
  }
  return hasWhere;
}

/**
 * Index of the terminating semicolon, or `end` if this statement runs to the
 * scan boundary. Comments and quoted spans cannot hide the terminator.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function sqlStatementEnd(source, start, end) {
  let index = start;
  let state = "code";
  while (index < end) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (character === "'" && next === "'") index += 2;
      else if (character === "'") {
        state = "code";
        index += 1;
      } else index += 1;
      continue;
    }
    if (state === "double-quote") {
      if (character === '"' && next === '"') index += 2;
      else if (character === '"') {
        state = "code";
        index += 1;
      } else index += 1;
      continue;
    }
    if (character === ";") return index;
    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 2;
      continue;
    }
    if (character === "'") {
      state = "single-quote";
      index += 1;
      continue;
    }
    if (character === '"') {
      state = "double-quote";
      index += 1;
      continue;
    }
    index += 1;
  }
  return end;
}

const DELETE_FROM_START = /^(delete\s+from)\b/i;
const TRUNCATE_START = /^(truncate(?:\s+(?:table|only))?\s+["'`A-Za-z_][A-Za-z0-9_."'`]*)/i;
const DROP_START = /^(drop\s+(?:table|database|schema))\b/i;
const SQL_BLOCK_OPENERS = new Set(["BEGIN", "DO", "THEN", "ELSE", "LOOP", "IF"]);

/**
 * Statement-anchored destructive SQL. A match must be the first token of a
 * statement (after trivia). `TRUNCATE` / `DROP` fire on identity; `DELETE FROM`
 * fires only when no `WHERE` token appears before the semicolon.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {number[]}
 */
function sqlDestructiveStatementHits(source, start, end) {
  const hits = [];
  let index = start;
  let atVerbPosition = true;
  while (index < end) {
    index = skipSqlTrivia(source, index, end);
    if (index >= end) break;
    if (atVerbPosition) {
      const rest = source.slice(index, end);
      const deleteMatch = DELETE_FROM_START.exec(rest);
      if (deleteMatch) {
        const stmtEnd = sqlStatementEnd(source, index, end);
        if (!sqlStatementHasWhere(source, index + deleteMatch[0].length, stmtEnd)) {
          hits.push(index);
        }
        index = stmtEnd < end && source[stmtEnd] === ";" ? stmtEnd + 1 : stmtEnd;
        atVerbPosition = true;
        continue;
      }
      const truncateMatch = TRUNCATE_START.exec(rest);
      if (truncateMatch) {
        hits.push(index);
        const stmtEnd = sqlStatementEnd(source, index, end);
        index = stmtEnd < end && source[stmtEnd] === ";" ? stmtEnd + 1 : stmtEnd;
        atVerbPosition = true;
        continue;
      }
      const dropMatch = DROP_START.exec(rest);
      if (dropMatch) {
        hits.push(index);
        const stmtEnd = sqlStatementEnd(source, index, end);
        index = stmtEnd < end && source[stmtEnd] === ";" ? stmtEnd + 1 : stmtEnd;
        atVerbPosition = true;
        continue;
      }
    }
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    // CTE / statement-separator: the next verb is a real SQL start.
    // English "to delete from the list" is not preceded by `)` or `;`.
    if (character === ")" || character === ";") {
      index += 1;
      atVerbPosition = true;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const innerStart = index + 1;
      index += 1;
      while (index < end) {
        if (source[index] === quote && source[index + 1] === quote) {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          if (innerStart < index) {
            hits.push(...sqlDestructiveStatementHits(source, innerStart, index));
          }
          index += 1;
          break;
        }
        index += 1;
      }
      atVerbPosition = false;
      continue;
    }
    if (character === "-" && next === "-") {
      index = skipSqlTrivia(source, index, end);
      continue;
    }
    if (isWordStart(character)) {
      let wordEnd = index + 1;
      while (wordEnd < end && isWordPart(source[wordEnd] ?? "")) wordEnd += 1;
      const word = source.slice(index, wordEnd).toUpperCase();
      index = wordEnd;
      atVerbPosition = SQL_BLOCK_OPENERS.has(word);
      continue;
    }
    index += 1;
    atVerbPosition = false;
  }
  return hits;
}

/** @param {string} source */
function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

/** @param {string} source */
function lineTextAt(source, line) {
  return source.split("\n")[line - 1] ?? "";
}

/**
 * Host-language quote end for a payload embedded in `.sh` / `.yml` / `.json`.
 * Backslash escapes must not open a phantom region on an apostrophe in prose.
 *
 * @param {string} source
 * @param {number} offset
 */
function hostQuoteEnd(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  let quote = "";
  for (let index = lineStart; index < offset; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
    }
  }
  if (!quote) return source.length;
  for (let index = offset; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) return index;
  }
  return source.length;
}

function inSqlLineComment(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  let quote = "";
  for (let index = lineStart; index < offset; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "-" && next === "-") return true;
  }
  return false;
}

/**
 * Committed Prisma migrations (repository-relative, exact folder shape:
 * `migration.sql`, and the `contract.sql` the deploy runner applies after the
 * soak) are reviewed schema-change SQL: `DROP TABLE`, `TRUNCATE`, and backfill
 * `DELETE` are expected there and summarized by PR CI. `DROP DATABASE|SCHEMA`
 * stays a hit even inside a migration.
 *
 * @param {string} path
 */
function isMigrationSqlPath(path) {
  return /^packages\/db\/prisma\/migrations\/[^/]+\/(migration|contract)\.sql$/.test(path);
}

function rawUnanchoredSqlHits(source, path) {
  // `--` is SQL comment syntax only in `.sql`. In host files it is a long
  // flag (`psql --dbname … -c "DELETE FROM …"`), and the policy layer already
  // drops line-start comments.
  const skipSqlComments = path.endsWith(".sql");
  const hits = [];
  if (isMigrationSqlPath(path)) {
    const schemaDropMatcher = /\bdrop\s+(?:database|schema)\b/gi;
    for (
      let match = schemaDropMatcher.exec(source);
      match;
      match = schemaDropMatcher.exec(source)
    ) {
      if (inSqlLineComment(source, match.index)) continue;
      hits.push({ line: lineAt(source, match.index), column: match.index });
    }
    return hits;
  }
  const deleteMatcher = /\bdelete\s+from\b/gi;
  for (let match = deleteMatcher.exec(source); match; match = deleteMatcher.exec(source)) {
    if (skipSqlComments && inSqlLineComment(source, match.index)) continue;
    const end = hostQuoteEnd(source, match.index);
    if (!sqlStatementHasWhere(source, match.index + match[0].length, end)) {
      hits.push({ line: lineAt(source, match.index), column: match.index });
    }
  }
  const truncateMatcher = /\btruncate\s+(?:(?:table|only)\s+)?["'`A-Za-z_][A-Za-z0-9_."'`]*/gi;
  for (let match = truncateMatcher.exec(source); match; match = truncateMatcher.exec(source)) {
    if (skipSqlComments && inSqlLineComment(source, match.index)) continue;
    hits.push({ line: lineAt(source, match.index), column: match.index });
  }
  const dropMatcher = /\bdrop\s+(?:table|database|schema)\b/gi;
  for (let match = dropMatcher.exec(source); match; match = dropMatcher.exec(source)) {
    if (skipSqlComments && inSqlLineComment(source, match.index)) continue;
    hits.push({ line: lineAt(source, match.index), column: match.index });
  }
  return hits;
}

function rawDestructiveSqlHits(source, path) {
  // Host-language files and `.sql` both use the unanchored payload matcher.
  // plpgsql bodies and quoted arguments are ordinary SQL. JS string literals
  // stay statement-anchored so English copy is not a hit.
  return rawUnanchoredSqlHits(source, path);
}

/** @param {string} path */
function scanFile(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read destructive-policy candidate ${path}: ${error.message}`);
  }
  const classification = classifyCandidate(source, path);
  const seen = new Set();
  const hits = [
    ...(classification === "javascript"
      ? literalOperationHits(source, path)
      : rawDestructiveSqlHits(source, path)),
  ];
  return hits
    .filter(({ line }) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .map(({ line }) => `${path}:${line}:${lineTextAt(source, line)}`);
}

async function selfTest() {
  const directory = mkdtempSync(join(tmpdir(), `destructive-policy-${process.pid}-`));
  const path = join(directory, "literals.tsx");
  const del = ["dele", "teMany"].join("");
  const sql = ["dele", "te from"].join("");
  const truncateSql = ["TRUN", "CATE"].join("");
  const source = [
    `client.user.${del}();`,
    `client.user.${del}(undefined);`,
    `client.user.${del}(void 0);`,
    `client.user.${del}(null);`,
    `client.user.${del}({});`,
    `client.user.${del}({ where: /* literal empty */ {} });`,
    `client.user.${del}({ limit: 1 });`,
    `client.user.${del}({ where: undefined });`,
    `client.user.${del}({ where: { id: "known" } });`,
    "client.user[dynamicMethod]();",
    `client.user["${del}"]();`,
    `client.user.${del}({ ...dynamicOptions });`,
    `client.user.${del}({ where: {}, ...dynamicOptions });`,
    `client.user.${del}({ ...dynamicOptions, where: {} });`,
    `client.user.${del}({ [dynamicOption]: value });`,
    `client.user.${del}({ where: {}, [dynamicOption]: value });`,
    `client.user.${del}({ [dynamicOption]: value, where: {} });`,
    `const multi = \`${sql} users; ${sql} audit WHERE id = 1;\`;`,
    `const comment = \`${sql} users -- WHERE in a comment\\n;\`;`,
    `const first = "${sql} users"; const second = "${sql} audit WHERE id = 1";`,
    `const quoted = \`${sql} users WHERE note = 'WHERE';\`;`,
    `const stringOnly = \`${sql} users note = 'WHERE';\`;`,
    `const identifierOnly = \`${sql} "WHERE";\`;`,
    `const table = \`${sql} where_table;\`;`,
    `const sibling = \`${sql} users; ${sql} audit WHERE id = 1;\`;`,
    `const truncate = \`${truncateSql} users\`;`,
  ].join("\n");
  try {
    writeFileSync(path, source, "utf8");
    const lines = scanFile(path).map((hit) => Number(hit.split(":", 3)[1]));
    const expected = [1, 2, 3, 5, 6, 7, 8, 11, 14, 17, 18, 19, 20, 22, 23, 24, 25, 26];
    if (JSON.stringify(lines) !== JSON.stringify(expected)) {
      throw new Error(`self-test expected lines ${expected.join(",")}, got ${lines.join(",")}`);
    }
    const englishCopy = join(directory, "copy.tsx");
    writeFileSync(
      englishCopy,
      'export const copy = "Select items to delete from the list";\n',
      "utf8",
    );
    if (scanFile(englishCopy).length !== 0) {
      throw new Error("self-test treated ordinary English list-copy as SQL");
    }
    const hostDelete = join(directory, "host.sh");
    writeFileSync(hostDelete, `psql "$DATABASE_URL" -c "${sql} sessions;"\n`, "utf8");
    if (scanFile(hostDelete).length !== 1) {
      throw new Error("self-test missed DELETE FROM inside a host-language quoted argument");
    }
    const hostLongFlag = join(directory, "host-long-flag.sh");
    writeFileSync(hostLongFlag, `psql --dbname "$DATABASE_URL" -c "${sql} sessions;"\n`, "utf8");
    if (scanFile(hostLongFlag).length !== 1) {
      throw new Error("self-test missed DELETE FROM after a host-language long flag");
    }
    const hostDropFlag = join(directory, "host-drop.sh");
    const dropSql = ["DR", "OP TABLE users;"].join("");
    writeFileSync(hostDropFlag, `psql --no-psqlrc -c "${dropSql}"\n`, "utf8");
    if (scanFile(hostDropFlag).length !== 1) {
      throw new Error("self-test missed a DROP" + " TABLE payload after a host-language long flag");
    }
    const hostTruncate = join(directory, "host-truncate.sh");
    writeFileSync(hostTruncate, `psql -c "${truncateSql} users CASCADE;"\n`, "utf8");
    if (scanFile(hostTruncate).length !== 1) {
      throw new Error("self-test missed TRUNCATE … CASCADE inside a host-language argument");
    }
    const cteSql = join(directory, "cte.sql");
    writeFileSync(cteSql, `WITH x AS (SELECT 1) ${sql} users;\n`, "utf8");
    if (scanFile(cteSql).length !== 1) {
      throw new Error("self-test missed CTE-wrapped DELETE FROM in SQL");
    }
    const cteTsx = join(directory, "cte.tsx");
    writeFileSync(cteTsx, `export const q = \`WITH x AS (SELECT 1) ${sql} users;\`;\n`, "utf8");
    if (scanFile(cteTsx).length !== 1) {
      throw new Error("self-test missed CTE-wrapped DELETE FROM in a JS string");
    }
    const plpgsql = join(directory, "plpgsql.sql");
    writeFileSync(plpgsql, `BEGIN\n${sql} users;\nEND;\n`, "utf8");
    if (scanFile(plpgsql).length !== 1) {
      throw new Error("self-test missed DELETE FROM inside a BEGIN/END body");
    }
    const execFn = join(directory, "exec.tsx");
    writeFileSync(execFn, `export const q = "SELECT exec_fn('${sql} users')";\n`, "utf8");
    if (scanFile(execFn).length !== 1) {
      throw new Error("self-test missed DELETE FROM inside a quoted SQL argument");
    }
    const plpgsqlJs = join(directory, "plpgsql.tsx");
    writeFileSync(plpgsqlJs, `export const q = \`BEGIN\n${sql} users;\nEND;\`;\n`, "utf8");
    if (scanFile(plpgsqlJs).length !== 1) {
      throw new Error("self-test missed DELETE FROM after BEGIN in a JS string");
    }
    const sqlComments = join(directory, "seed.sql");
    writeFileSync(
      sqlComments,
      ["-- Truncate table data before seed", "SELECT 1;", "-- TRUNCATE users"].join("\n"),
      "utf8",
    );
    if (scanFile(sqlComments).length !== 0) {
      throw new Error("self-test treated SQL line comments as live TRUNCATE");
    }
    const multilineDrop = join(directory, "multiline.sql");
    writeFileSync(multilineDrop, "DROP\nTABLE users;\n", "utf8");
    if (scanFile(multilineDrop).length !== 1) {
      throw new Error("self-test missed a newline-split DROP" + " TABLE statement");
    }
    const migrationDir = join(directory, "packages/db/prisma/migrations/20260101000000_x");
    mkdirSync(migrationDir, { recursive: true });
    const dropWord = ["DR", "OP"].join("");
    writeFileSync(
      join(migrationDir, "migration.sql"),
      [
        `${dropWord} TABLE "legacy";`,
        `${["TRUN", "CATE"].join("")} "legacy";`,
        `${["DELE", "TE FROM"].join("")} "legacy";`,
        `${dropWord}\nSCHEMA public CASCADE;`,
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(migrationDir, "other.sql"), `${dropWord} TABLE "legacy";\n`, "utf8");
    writeFileSync(
      join(migrationDir, "contract.sql"),
      [`${dropWord} TABLE "legacy";`, `${dropWord}\nSCHEMA public CASCADE;`].join("\n"),
      "utf8",
    );
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const migrationHits = scanFile(
        "packages/db/prisma/migrations/20260101000000_x/migration.sql",
      );
      if (migrationHits.length !== 1 || !migrationHits[0]?.includes(":4:")) {
        throw new Error(
          "self-test migration.sql exemption is wrong (expected only the schema drop)",
        );
      }
      const contractHits = scanFile("packages/db/prisma/migrations/20260101000000_x/contract.sql");
      if (contractHits.length !== 1 || !contractHits[0]?.includes(":2:")) {
        throw new Error(
          "self-test contract.sql exemption is wrong (expected only the schema drop)",
        );
      }
      if (scanFile("packages/db/prisma/migrations/20260101000000_x/other.sql").length !== 1) {
        throw new Error("self-test exempted a non-migration .sql file in the migrations folder");
      }
    } finally {
      process.chdir(previousCwd);
    }
    const localePath = "packages/locales/src/en-US/common.json";
    if ((await auditedContext(localePath, 1)) !== "mention") {
      throw new Error("self-test did not classify locale JSON as a mention");
    }
    const auditedContextPath = join(directory, "audited-context.mjs");
    const destructiveSql = ["DROP", " TABLE fixture"].join("");
    writeFileSync(
      auditedContextPath,
      [
        `console.error("${destructiveSql}");`,
        `const BASH_RULES = [{ name: "fixture", test: () => false, reason: "${destructiveSql}" }];`,
        "async function selfTest() {",
        `  const bashCases = [["${destructiveSql}", true]];`,
        "}",
        `const carrier = ["${destructiveSql}"];`,
        'exec(carrier.join(" "));',
        `const template = \`${destructiveSql}\`;`,
        "exec(template);",
        `console.log(exec("${destructiveSql}"));`,
        `const BASH_RULES_WITH_EXECUTOR = [{ name: "fixture", test: () => false, reason: exec("${destructiveSql}") }];`,
        "async function selfTest() {",
        `  const bashCases = [[exec("${destructiveSql}"), true]];`,
        "}",
        `function parser(arg) { return arg === exec("${destructiveSql}"); }`,
        `const classifyCases = [["fixture", exec("${destructiveSql}"), "destructive"]];`,
      ].join("\n"),
      "utf8",
    );
    if ((await auditedContext(auditedContextPath, 1)) !== "mention") {
      throw new Error("self-test rejected a direct inert console display literal");
    }
    if (
      javascriptAuditedContext(
        readFileSync(auditedContextPath, "utf8"),
        "scripts/claude-hooks/pre-tool-use.mjs",
        2,
      ) !== "mention"
    ) {
      throw new Error("self-test rejected the fixed hook denial-reason table");
    }
    if (
      javascriptAuditedContext(
        readFileSync(auditedContextPath, "utf8"),
        "scripts/claude-hooks/pre-tool-use.mjs",
        4,
      ) !== "mention"
    ) {
      throw new Error("self-test rejected the finite hook parser-fixture tuple");
    }
    for (const line of [6, 8, 10, 11]) {
      if ((await auditedContext(auditedContextPath, line)) !== "live") {
        throw new Error(`self-test accepted assigned audited carrier on line ${line}`);
      }
    }
    for (const line of [13, 15]) {
      if (
        javascriptAuditedContext(
          readFileSync(auditedContextPath, "utf8"),
          "scripts/claude-hooks/pre-tool-use.mjs",
          line,
        ) !== "live"
      ) {
        throw new Error(`self-test accepted an executor in a hook exception on line ${line}`);
      }
    }
    const bashRuleExecutorSource = `const BASH_RULES = [{ name: "fixture", test: () => false, reason: exec("${destructiveSql}") }];`;
    if (
      javascriptAuditedContext(
        bashRuleExecutorSource,
        "scripts/claude-hooks/pre-tool-use.mjs",
        1,
      ) !== "live"
    ) {
      throw new Error("self-test accepted an executor in a hook denial reason");
    }
    const regexExecutorSource = [
      `const detector = /${destructiveSql}/;`,
      "exec(detector.source);",
    ].join("\n");
    if (
      javascriptAuditedContext(regexExecutorSource, "scripts/db/check-migrations.mjs", 1) !== "live"
    ) {
      throw new Error("self-test accepted a regex handed to an executor");
    }
    const yamlContextPath = join(directory, "audited-context.yaml");
    writeFileSync(
      yamlContextPath,
      [`run: |`, `  command="${destructiveSql}"`, '  eval "$command"'].join("\n"),
      "utf8",
    );
    if ((await auditedContext(yamlContextPath, 2)) !== "live") {
      throw new Error("self-test accepted an audited YAML block carrier");
    }
    const shellContextPath = join(directory, "audited-context.sh");
    writeFileSync(
      shellContextPath,
      [
        `echo "${destructiveSql}"`,
        `echo "$(printf '%s' '${destructiveSql}')"`,
        `printf '%s\\n' '${destructiveSql}'`,
        `printf -v assigned '%s\\n' '${destructiveSql}'`,
        `echo '${destructiveSql}' > audit-output`,
        `payload="${destructiveSql}"`,
        'eval "$payload"',
        `if [[ "${destructiveSql}" == "${destructiveSql}" ]]; then :; fi`,
        `if [[ "$(printf '%s' '${destructiveSql}')" == x ]]; then :; fi`,
        `[[ x == x ]]; psql -c '${destructiveSql}'`,
        `echo safe; psql -c '${destructiveSql}'`,
        `echo safe && psql -c '${destructiveSql}'`,
        `if [[ x == x ]] && psql -c '${destructiveSql}' && [[ x == x ]]; then :; fi`,
      ].join("\n"),
      "utf8",
    );
    if ((await auditedContext(shellContextPath, 1)) !== "mention") {
      throw new Error("self-test rejected an inert shell display literal");
    }
    if ((await auditedContext(shellContextPath, 3)) !== "mention") {
      throw new Error("self-test rejected the bounded printf display form");
    }
    if (
      (await shellAuditedContext(
        "scripts/policy-checks.sh",
        readFileSync(shellContextPath, "utf8"),
        13,
      )) !== "live"
    ) {
      throw new Error("self-test accepted a shell conditional as an inert display statement");
    }
    for (const line of [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      if ((await auditedContext(shellContextPath, line)) !== "live") {
        throw new Error(`self-test accepted executable shell carrier on line ${line}`);
      }
    }
    const shellContainmentCases = [
      [
        "direct root echo",
        "mention",
        `echo "${destructiveSql}" # destructive:audited — root display fixture`,
      ],
      [
        "direct root printf",
        "mention",
        `printf '%s\\n' '${destructiveSql}' # destructive:audited — root display fixture`,
      ],
      [
        "eval command substitution",
        "live",
        [
          'eval "$( ',
          `  echo "${destructiveSql}" # destructive:audited — captured fixture`,
          ')"',
        ].join("\n"),
      ],
      [
        "backtick capture",
        "live",
        [
          "payload=`",
          `  echo "${destructiveSql}" # destructive:audited — captured fixture`,
          "`",
          'eval "$payload"',
        ].join("\n"),
      ],
      [
        "same-line sibling",
        "live",
        `echo "${destructiveSql}"; : # destructive:audited — sibling fixture`,
      ],
      [
        "redirect wrapper",
        "live",
        `echo "${destructiveSql}" > audit-output # destructive:audited — redirect fixture`,
      ],
      [
        "pipeline wrapper",
        "live",
        `echo "${destructiveSql}" | cat # destructive:audited — pipeline fixture`,
      ],
      [
        "function body",
        "live",
        [
          "fixture() {",
          `  echo "${destructiveSql}" # destructive:audited — function fixture`,
          "}",
        ].join("\n"),
      ],
      [
        "subshell body",
        "live",
        ["(", `  echo "${destructiveSql}" # destructive:audited — subshell fixture`, ")"].join(
          "\n",
        ),
      ],
      [
        "heredoc body",
        "live",
        [
          "cat <<'AUDIT_FIXTURE'",
          `${destructiveSql} # destructive:audited — heredoc fixture`,
          "AUDIT_FIXTURE",
        ].join("\n"),
      ],
      [
        "malformed complete source",
        "live",
        [
          `echo "${destructiveSql}" # destructive:audited — malformed-source fixture`,
          "if [[ x == x ]]; then",
        ].join("\n"),
      ],
    ];
    for (const [label, expected, source] of shellContainmentCases) {
      const markedLine = source
        .split("\n")
        .findIndex((entry) => entry.includes("destructive:audited"));
      if (markedLine === -1) throw new Error(`self-test has no marked ${label} fixture`);
      if ((await shellAuditedContext("fixture.sh", source, markedLine + 1)) !== expected) {
        throw new Error(`self-test misclassified complete-source ${label} fixture`);
      }
    }
    const detectorDelete = ["dele", "te from fixture"].join("");
    const detectorSource = [
      `DESTRUCTIVE_RE='${destructiveSql}'`,
      `DELETE_RE='${detectorDelete}'`,
      'AUDIT_MATCH_RE="($DESTRUCTIVE_RE)|($DELETE_RE)"',
    ].join("\n");
    for (const line of [1, 2, 3]) {
      if (
        (await shellAuditedContext("scripts/policy-checks.sh", detectorSource, line)) !== "mention"
      ) {
        throw new Error(`self-test rejected exact detector assignment ${line}`);
      }
    }
    const detectorSubstitutionSource = [
      `DESTRUCTIVE_RE="$(printf '%s' '${destructiveSql}')"`,
      `DELETE_RE='${detectorDelete}'`,
      'AUDIT_MATCH_RE="($DESTRUCTIVE_RE)|($DELETE_RE)"',
    ].join("\n");
    if (
      (await shellAuditedContext("scripts/policy-checks.sh", detectorSubstitutionSource, 1)) !==
      "live"
    ) {
      throw new Error("self-test accepted a detector command substitution");
    }
    const detectorSiblingSource = [
      `DESTRUCTIVE_RE='${destructiveSql}'; echo safe`,
      `DELETE_RE='${detectorDelete}'`,
      'AUDIT_MATCH_RE="($DESTRUCTIVE_RE)|($DELETE_RE)"',
    ].join("\n");
    if (
      (await shellAuditedContext("scripts/policy-checks.sh", detectorSiblingSource, 1)) !== "live"
    ) {
      throw new Error("self-test accepted a detector assignment with a sibling command");
    }
    const dockerContextPath = join(directory, "Dockerfile.audit-context");
    writeFileSync(dockerContextPath, [`RUN echo "${destructiveSql}"`].join("\n"), "utf8");
    if ((await auditedContext(dockerContextPath, 1)) !== "live") {
      throw new Error("self-test accepted a Dockerfile RUN carrier");
    }
    const knownNode = join(directory, "node-script");
    const knownShell = join(directory, "shell-script");
    const directNode = join(directory, "direct-node-script");
    const directBun = join(directory, "direct-bun-script");
    const directTsx = join(directory, "direct-tsx-script");
    const directShell = join(directory, "direct-shell-script");
    const knownData = join(directory, "fixture.jsonl");
    const malformedJavaScript = join(directory, "malformed.mjs");
    const unclassifiedSource = join(directory, "extensionless-node-source");
    const foreignLaterWord = join(directory, "foreign-later-word");
    const foreignEnvRuntime = join(directory, "foreign-env-runtime");
    const splitEnvForm = join(directory, "split-env-form");
    const envRuntimeArgument = join(directory, "env-runtime-argument");
    const directRuntimeArgument = join(directory, "direct-runtime-argument");
    const pythonJavaScriptSuffix = join(directory, "python-header.js");
    const shellJavaScriptSuffix = join(directory, "shell-header.mjs");
    const nodeShellSuffix = join(directory, "node-header.sh");
    const binary = join(directory, "binary.sql");
    writeFileSync(knownNode, "#!/usr/bin/env node\nexport {};\n", "utf8");
    writeFileSync(knownShell, "#!/usr/bin/env bash\nprintf safe\\n", "utf8");
    writeFileSync(directNode, "#!/usr/bin/node\nexport {};\n", "utf8");
    writeFileSync(directBun, "#!/usr/bin/bun\nexport {};\n", "utf8");
    writeFileSync(directTsx, "#!/usr/bin/tsx\nexport {};\n", "utf8");
    writeFileSync(directShell, "#!/bin/sh\nprintf safe\\n", "utf8");
    writeFileSync(knownData, '{"fixture":true}\n', "utf8");
    writeFileSync(malformedJavaScript, "const = ;\n", "utf8");
    writeFileSync(unclassifiedSource, "export {};\n", "utf8");
    writeFileSync(foreignLaterWord, "#!/usr/bin/python node\nexport {};\n", "utf8");
    writeFileSync(foreignEnvRuntime, "#!/usr/bin/env python node\nexport {};\n", "utf8");
    writeFileSync(splitEnvForm, "#!/usr/bin/env -S node\nexport {};\n", "utf8");
    writeFileSync(envRuntimeArgument, "#!/usr/bin/env node --inspect\nexport {};\n", "utf8");
    writeFileSync(directRuntimeArgument, "#!/usr/bin/node --inspect\nexport {};\n", "utf8");
    writeFileSync(pythonJavaScriptSuffix, "#!/usr/bin/python\nexport {};\n", "utf8");
    writeFileSync(shellJavaScriptSuffix, "#!/bin/sh\nexport {};\n", "utf8");
    writeFileSync(nodeShellSuffix, "#!/usr/bin/node\nprintf safe\n", "utf8");
    writeFileSync(binary, Buffer.from([0, 1, 2]));
    for (const knownPath of [
      knownNode,
      knownShell,
      directNode,
      directBun,
      directTsx,
      directShell,
      knownData,
    ]) {
      if (scanFile(knownPath).length !== 0) {
        throw new Error(
          `self-test unexpectedly found an operation in known candidate ${knownPath}`,
        );
      }
    }
    for (const [label, rejectedPath] of [
      ["malformed JavaScript", malformedJavaScript],
      ["extensionless no-shebang source", unclassifiedSource],
      ["foreign later shebang word", foreignLaterWord],
      ["foreign env runtime", foreignEnvRuntime],
      ["env split form", splitEnvForm],
      ["env runtime argument", envRuntimeArgument],
      ["direct runtime argument", directRuntimeArgument],
      ["Python header on JavaScript suffix", pythonJavaScriptSuffix],
      ["shell header on JavaScript suffix", shellJavaScriptSuffix],
      ["Node header on shell suffix", nodeShellSuffix],
      ["binary candidate", binary],
    ]) {
      try {
        scanFile(rejectedPath);
      } catch {
        continue;
      }
      throw new Error(`self-test accepted ${label}`);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

const [mode, ...paths] = process.argv.slice(2);
try {
  if (mode === "--self-test") {
    await selfTest();
    console.log("destructive-operation scanner self-test passed.");
  } else if (mode === "--scan" && paths.length > 0) {
    for (const path of paths) {
      for (const hit of scanFile(path)) console.log(hit);
    }
  } else if (mode === "--audited-context" && paths.length === 2 && /^\d+$/.test(paths[1] ?? "")) {
    console.log(await auditedContext(paths[0] ?? "", Number(paths[1])));
  } else {
    throw new Error(
      "usage: node scripts/check-destructive-operations.mjs --self-test | --scan <candidate>... | --audited-context <candidate> <line>",
    );
  }
} catch (error) {
  console.error(`destructive-operation scanner failed: ${error.message}`);
  process.exitCode = 1;
}
