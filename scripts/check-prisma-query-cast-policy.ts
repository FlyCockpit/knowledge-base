import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const { parse } = createRequire(import.meta.url)("@babel/parser") as typeof import("@babel/parser");
const OPERATIONS = new Set([
  "aggregate",
  "count",
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const CLIENT_RESULT_OPERATIONS = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
  "$transaction",
]);
const TAGGED_CLIENT_RESULT_OPERATIONS = new Set(["$executeRaw", "$queryRaw"]);
const TRANSPARENT_EXPRESSIONS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSInstantiationExpression",
]);
const TYPE_WRAPPERS = new Set(["TSAsExpression", "TSTypeAssertion"]);
const FUNCTION_NODES = new Set([
  "ArrowFunctionExpression",
  "ClassMethod",
  "ClassPrivateMethod",
  "FunctionDeclaration",
  "FunctionExpression",
  "ObjectMethod",
]);
const EXCLUDED_PARTS = new Set([".git", "dist", "node_modules", "prisma/generated"]);

type AstNode = {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};
type Provenance = "client" | "result" | false;
type Environment = Map<string, Provenance>;
type Violation = { file: string; line: number; column: number };

function node(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as AstNode)
    : undefined;
}

/** Unwrap syntax around a value without claiming that a type assertion proves its origin. */
function unwrapRuntimeValue(value: AstNode): AstNode {
  let current = value;
  while (TRANSPARENT_EXPRESSIONS.has(current.type) || TYPE_WRAPPERS.has(current.type)) {
    const expression = node(
      current.type === "AwaitExpression" ? current.argument : current.expression,
    );
    if (!expression) break;
    current = expression;
  }
  return current;
}

/** Return a member's statically knowable key; dynamic computed keys are deliberately excluded. */
function staticMemberName(value: AstNode): string | undefined {
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression")
    return undefined;
  const property = node(value.property);
  if (!property) return undefined;
  if (property.type === "Identifier" && value.computed !== true) return property.name as string;
  if (property.type === "StringLiteral") return property.value as string;
  if (property.type === "TemplateLiteral") {
    const expressions = property.expressions as unknown[] | undefined;
    const quasis = property.quasis as AstNode[] | undefined;
    if (expressions?.length === 0 && quasis?.length === 1) {
      const quasiValue = quasis[0]?.value as { cooked?: unknown } | undefined;
      if (typeof quasiValue?.cooked === "string") return quasiValue.cooked;
    }
  }
  return undefined;
}

function identifierName(value: unknown): string | undefined {
  const candidate = node(value);
  return candidate?.type === "Identifier" ? (candidate.name as string) : undefined;
}

function bindingNames(value: unknown): string[] {
  const current = node(value);
  if (!current) return [];
  const name = identifierName(current);
  if (name) return [name];
  if (current.type === "AssignmentPattern") return bindingNames(current.left);
  if (current.type === "RestElement") return bindingNames(current.argument);
  if (current.type === "TSParameterProperty") return bindingNames(current.parameter);
  if (current.type === "ArrayPattern")
    return ((current.elements as unknown[] | undefined) ?? []).flatMap(bindingNames);
  if (current.type === "ObjectPattern")
    return ((current.properties as AstNode[] | undefined) ?? []).flatMap((property) =>
      property.type === "RestElement"
        ? bindingNames(property.argument)
        : bindingNames(property.value),
    );
  return [];
}

function hasPrismaProvenance(value: AstNode, environment: Environment): boolean {
  // Assertions preserve already-established provenance, but can never manufacture it.
  const name = identifierName(unwrapRuntimeValue(value));
  return name !== undefined && environment.get(name) === "client";
}

function declarationBindings(value: unknown): string[] {
  const declaration = node(value);
  if (!declaration) return [];
  if (declaration.type === "VariableDeclaration")
    return ((declaration.declarations as AstNode[] | undefined) ?? []).flatMap((item) =>
      bindingNames(item.id),
    );
  if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
    return bindingNames(declaration.id);
  return [];
}

function lexicalDeclarationBindings(value: unknown): string[] {
  const declaration = node(value);
  if (!declaration) return [];
  if (declaration.type === "VariableDeclaration" && declaration.kind !== "var")
    return declarationBindings(declaration);
  if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
    return declarationBindings(declaration);
  return [];
}

function lexicalEnvironment(environment: Environment, owners: unknown[]): Environment {
  const scoped = new Map(environment);
  for (const owner of owners)
    for (const name of lexicalDeclarationBindings(owner)) scoped.set(name, false);
  return scoped;
}

/** Collect `var` names owned by one program/function scope, excluding nested owners. */
function hoistedVarBindings(value: unknown, root = true): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => hoistedVarBindings(item, false));
  const current = node(value);
  if (!current) return [];
  if (!root && (FUNCTION_NODES.has(current.type) || current.type === "StaticBlock")) return [];
  if (current.type === "VariableDeclaration" && current.kind === "var")
    return declarationBindings(current);
  return childNodes(current).flatMap((child) => hoistedVarBindings(child, false));
}

function prismaDelegateCall(value: AstNode, environment: Environment): AstNode | undefined {
  const candidate = unwrapRuntimeValue(value);
  if (candidate.type !== "CallExpression" && candidate.type !== "OptionalCallExpression")
    return undefined;
  const callee = node(candidate.callee);
  if (!callee) return undefined;
  const normalizedCallee = unwrapRuntimeValue(callee);
  const operation = staticMemberName(normalizedCallee);
  if (!operation || !OPERATIONS.has(operation)) return undefined;
  const model = node(normalizedCallee.object);
  if (!model) return undefined;
  const normalizedModel = unwrapRuntimeValue(model);
  if (
    normalizedModel.type !== "MemberExpression" &&
    normalizedModel.type !== "OptionalMemberExpression"
  )
    return undefined;
  const receiver = node(normalizedModel.object);
  return receiver !== undefined && hasPrismaProvenance(receiver, environment)
    ? candidate
    : undefined;
}

/** Resolve a result-producing operation called directly on a proven Prisma client. */
function prismaClientResultOperation(
  value: AstNode,
  environment: Environment,
): AstNode | undefined {
  const candidate = unwrapRuntimeValue(value);
  const isCall = candidate.type === "CallExpression" || candidate.type === "OptionalCallExpression";
  const isTaggedTemplate = candidate.type === "TaggedTemplateExpression";
  if (!isCall && !isTaggedTemplate) return undefined;
  const callee = node(isTaggedTemplate ? candidate.tag : candidate.callee);
  if (!callee) return undefined;
  const normalizedCallee = unwrapRuntimeValue(callee);
  const operation = staticMemberName(normalizedCallee);
  if (
    !operation ||
    !(isTaggedTemplate
      ? TAGGED_CLIENT_RESULT_OPERATIONS.has(operation)
      : CLIENT_RESULT_OPERATIONS.has(operation))
  )
    return undefined;
  const receiver = node(normalizedCallee.object);
  return receiver !== undefined && hasPrismaProvenance(receiver, environment)
    ? candidate
    : undefined;
}

function directPrismaResult(value: AstNode, environment: Environment): AstNode | undefined {
  return prismaDelegateCall(value, environment) ?? prismaClientResultOperation(value, environment);
}

/**
 * Resolve a Prisma result at the assertion site.
 *
 * Besides a Prisma result expression asserted inline, this intentionally follows one
 * bounded local hop: an immutable identifier initialized directly from a
 * proven delegate, transaction, or raw operation. It does not follow helper returns, destructuring, or
 * mutable bindings.
 */
function prismaResultSource(value: AstNode, environment: Environment): AstNode | undefined {
  const direct = directPrismaResult(value, environment);
  if (direct) return direct;
  const candidate = unwrapRuntimeValue(value);
  const name = identifierName(candidate);
  return name !== undefined && environment.get(name) === "result" ? candidate : undefined;
}

function isTransactionCall(value: AstNode, environment: Environment): boolean {
  const operation = prismaClientResultOperation(value, environment);
  if (!operation || operation.type === "TaggedTemplateExpression") return false;
  const callee = node(operation.callee);
  return callee !== undefined && staticMemberName(unwrapRuntimeValue(callee)) === "$transaction";
}

function childNodes(value: AstNode): unknown[] {
  return Object.entries(value)
    .filter(([key]) => key !== "loc" && key !== "extra")
    .map(([, child]) => child);
}

export function findViolations(source: string, file = "fixture.ts"): Violation[] {
  const plugins: ("typescript" | "jsx")[] = file.endsWith(".tsx")
    ? ["typescript", "jsx"]
    : ["typescript"];
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: file,
    plugins,
    errorRecovery: false,
  });
  const violations: Violation[] = [];
  const seen = new Set<unknown>();
  const reportedResultSources = new Set<AstNode>();

  function visit(value: unknown, environment: Environment, transactionParameter = false): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, environment);
      return;
    }
    const current = node(value);
    if (!current || seen.has(current)) return;
    seen.add(current);
    if (current.type === "Program") {
      const body = (current.body as AstNode[] | undefined) ?? [];
      const programEnvironment = lexicalEnvironment(environment, body);
      // ESM imports are hoisted bindings even if unusual source ordering places one later.
      for (const statement of body)
        if (statement.type === "ImportDeclaration") visit(statement, programEnvironment);
      // `var` shadows an outer/imported name throughout its complete owning scope.
      for (const name of hoistedVarBindings(current)) programEnvironment.set(name, false);
      for (const statement of body)
        if (statement.type !== "ImportDeclaration") visit(statement, programEnvironment);
      return;
    }
    if (current.type === "BlockStatement") {
      const body = (current.body as AstNode[] | undefined) ?? [];
      visit(body, lexicalEnvironment(environment, body));
      return;
    }
    if (current.type === "StaticBlock") {
      const body = (current.body as AstNode[] | undefined) ?? [];
      const staticEnvironment = lexicalEnvironment(environment, body);
      for (const name of hoistedVarBindings(current)) staticEnvironment.set(name, false);
      visit(body, staticEnvironment);
      return;
    }
    if (current.type === "SwitchStatement") {
      const cases = (current.cases as AstNode[] | undefined) ?? [];
      const owners = cases.flatMap((item) => (item.consequent as unknown[] | undefined) ?? []);
      const switchEnvironment = lexicalEnvironment(environment, owners);
      visit(current.discriminant, environment);
      for (const switchCase of cases) {
        visit(switchCase.test, switchEnvironment);
        visit(switchCase.consequent, switchEnvironment);
      }
      return;
    }
    if (
      current.type === "ForStatement" ||
      current.type === "ForInStatement" ||
      current.type === "ForOfStatement"
    ) {
      const owner = current.type === "ForStatement" ? current.init : current.left;
      const loopEnvironment = lexicalEnvironment(environment, [owner]);
      if (current.type === "ForStatement") {
        visit(current.init, loopEnvironment);
        visit(current.test, loopEnvironment);
        visit(current.update, loopEnvironment);
      } else {
        // The iterable is evaluated before the loop-head binding is written.
        visit(current.right, environment);
        if (node(current.left)?.type === "VariableDeclaration") {
          visit(current.left, loopEnvironment);
        } else {
          visitAssignmentRuntime(current.left, loopEnvironment);
        }
      }
      visit(current.body, loopEnvironment);
      return;
    }
    if (current.type === "ImportDeclaration") {
      if (node(current.source)?.value === "@knowledge-base/db" && current.importKind !== "type") {
        for (const specifier of (current.specifiers as AstNode[] | undefined) ?? []) {
          const imported = node(specifier.imported);
          const importsDefault =
            specifier.type === "ImportDefaultSpecifier" ||
            (specifier.type === "ImportSpecifier" &&
              (identifierName(imported) === "default" || imported?.value === "default"));
          if (importsDefault && specifier.importKind !== "type") {
            const local = identifierName(specifier.local);
            if (local) environment.set(local, "client");
          }
        }
      }
      return;
    }
    if (current.type === "VariableDeclaration") {
      for (const declaration of (current.declarations as AstNode[] | undefined) ?? []) {
        const init = node(declaration.init);
        if (init) visit(init, environment);
        const names = bindingNames(declaration.id);
        // A bare `var` redeclaration (notably of a parameter) performs no runtime write.
        if (current.kind !== "var" || init) for (const name of names) environment.set(name, false);
        const directName = identifierName(declaration.id);
        if (current.kind === "const" && directName) {
          const provenance: Provenance = !init
            ? false
            : hasPrismaProvenance(init, environment)
              ? "client"
              : directPrismaResult(init, environment)
                ? "result"
                : false;
          environment.set(directName, provenance);
        }
        visitBindingRuntime(declaration.id, environment);
      }
      return;
    }
    if (FUNCTION_NODES.has(current.type)) {
      // Computed method keys execute in the enclosing scope, before parameters exist.
      if (current.computed === true) visit(current.key, environment);
      const functionEnvironment = new Map(environment);
      const functionName = identifierName(current.id);
      if (functionName) functionEnvironment.set(functionName, false);
      const parameters = (current.params as AstNode[] | undefined) ?? [];
      const parameterNames = new Set(parameters.flatMap(bindingNames));
      // All parameter bindings shadow outer names throughout the parameter environment.
      for (const parameter of parameters)
        for (const name of bindingNames(parameter)) functionEnvironment.set(name, false);

      function visitParameterRuntime(value: unknown): void {
        const parameter = node(value);
        if (!parameter) return;
        if (parameter.type === "TSParameterProperty") {
          visitParameterRuntime(parameter.parameter);
          return;
        }
        if (parameter.type === "AssignmentPattern") {
          visitParameterRuntime(parameter.left);
          visit(parameter.right, functionEnvironment);
          return;
        }
        if (parameter.type === "RestElement") {
          visitParameterRuntime(parameter.argument);
          return;
        }
        if (parameter.type === "ArrayPattern") {
          for (const element of (parameter.elements as unknown[] | undefined) ?? [])
            visitParameterRuntime(element);
          return;
        }
        if (parameter.type === "ObjectPattern") {
          for (const property of (parameter.properties as AstNode[] | undefined) ?? []) {
            if (property.type === "RestElement") visitParameterRuntime(property.argument);
            else {
              if (property.computed === true) visit(property.key, functionEnvironment);
              visitParameterRuntime(property.value);
            }
          }
        }
      }

      for (const [index, parameter] of parameters.entries()) {
        visitParameterRuntime(parameter);
        for (const name of bindingNames(parameter))
          functionEnvironment.set(name, transactionParameter && index === 0 ? "client" : false);
      }
      for (const name of hoistedVarBindings(current.body))
        if (!parameterNames.has(name)) functionEnvironment.set(name, false);
      visit(current.body, functionEnvironment);
      return;
    }
    if (current.type === "CatchClause") {
      const catchEnvironment = new Map(environment);
      for (const name of bindingNames(current.param)) catchEnvironment.set(name, false);
      visitBindingRuntime(current.param, catchEnvironment);
      visit(current.body, catchEnvironment);
      return;
    }
    if (current.type === "ClassExpression") {
      const classEnvironment = new Map(environment);
      const className = identifierName(current.id);
      if (className) classEnvironment.set(className, false);
      for (const child of childNodes(current)) visit(child, classEnvironment);
      return;
    }
    if (current.type === "AssignmentExpression") {
      const left = node(current.left);
      if (left?.type === "ObjectPattern" || left?.type === "ArrayPattern") {
        // Destructuring assignment evaluates its source first, then performs each
        // computed-key/default evaluation and target write in pattern order.
        visit(current.right, environment);
        visitAssignmentRuntime(left, environment);
      } else {
        // A member target's reference is evaluated before the assigned value.
        visit(current.left, environment);
        visit(current.right, environment);
        for (const name of bindingNames(current.left)) environment.set(name, false);
      }
      return;
    }
    if (current.type === "UpdateExpression") {
      visit(current.argument, environment);
      const name = identifierName(current.argument);
      if (name) environment.set(name, false);
      return;
    }
    const offendingCall =
      current.type === "TSAsExpression" || current.type === "TSTypeAssertion"
        ? prismaResultSource(node(current.expression) ?? current, environment)
        : undefined;
    if (offendingCall && !reportedResultSources.has(offendingCall)) {
      reportedResultSources.add(offendingCall);
      violations.push({
        file,
        line: current.loc?.start.line ?? 1,
        column: (current.loc?.start.column ?? 0) + 1,
      });
    }
    if (
      (current.type === "CallExpression" || current.type === "OptionalCallExpression") &&
      isTransactionCall(current, environment)
    ) {
      visit(current.callee, environment);
      const args = (current.arguments as AstNode[] | undefined) ?? [];
      for (const [index, argument] of args.entries()) {
        const runtimeArgument = unwrapRuntimeValue(argument);
        visit(
          runtimeArgument,
          environment,
          index === 0 && FUNCTION_NODES.has(runtimeArgument.type),
        );
      }
      return;
    }
    for (const child of childNodes(current)) visit(child, environment);
  }

  /** Visit expressions evaluated while a binding pattern is initialized. */
  function visitBindingRuntime(value: unknown, environment: Environment): void {
    const pattern = node(value);
    if (!pattern) return;
    if (pattern.type === "TSParameterProperty") {
      visitBindingRuntime(pattern.parameter, environment);
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      visitBindingRuntime(pattern.left, environment);
      visit(pattern.right, environment);
      return;
    }
    if (pattern.type === "RestElement") {
      visitBindingRuntime(pattern.argument, environment);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of (pattern.elements as unknown[] | undefined) ?? [])
        visitBindingRuntime(element, environment);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const property of (pattern.properties as AstNode[] | undefined) ?? []) {
        if (property.type === "RestElement") visitBindingRuntime(property.argument, environment);
        else {
          if (property.computed === true) visit(property.key, environment);
          visitBindingRuntime(property.value, environment);
        }
      }
    }
  }

  /** Execute a non-declaration assignment pattern in ECMAScript evaluation order. */
  function visitAssignmentRuntime(value: unknown, environment: Environment): void {
    const pattern = node(value);
    if (!pattern) return;
    if (pattern.type === "AssignmentPattern") {
      visit(pattern.right, environment);
      visitAssignmentRuntime(pattern.left, environment);
      return;
    }
    if (pattern.type === "RestElement") {
      visitAssignmentRuntime(pattern.argument, environment);
      return;
    }
    if (pattern.type === "ArrayPattern") {
      for (const element of (pattern.elements as unknown[] | undefined) ?? [])
        visitAssignmentRuntime(element, environment);
      return;
    }
    if (pattern.type === "ObjectPattern") {
      for (const property of (pattern.properties as AstNode[] | undefined) ?? []) {
        if (property.type === "RestElement") visitAssignmentRuntime(property.argument, environment);
        else {
          if (property.computed === true) visit(property.key, environment);
          visitAssignmentRuntime(property.value, environment);
        }
      }
      return;
    }
    visit(pattern, environment);
    const name = identifierName(pattern);
    if (name) environment.set(name, false);
  }
  visit(ast, new Map());
  return violations;
}

export function listPolicyFiles(root = process.cwd()): string[] {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return (
    result.stdout
      .split("\0")
      .filter(Boolean)
      // A tracked file can be absent from the worktree while staged for deletion.
      // Removable modules rely on that normal Git state and must remain scannable.
      .filter((file) => existsSync(path.join(root, file)))
      .filter((file) => {
        const parts = file.split("/");
        return !parts.some(
          (part, index) =>
            EXCLUDED_PARTS.has(part) || EXCLUDED_PARTS.has(parts.slice(index, index + 2).join("/")),
        );
      })
      .sort()
  );
}

function parseErrorLocation(error: unknown): { line: number; column: number } {
  const location =
    typeof error === "object" && error !== null && "loc" in error
      ? (error.loc as { line?: unknown; column?: unknown } | undefined)
      : undefined;
  return {
    line: typeof location?.line === "number" ? location.line : 1,
    column: typeof location?.column === "number" ? location.column + 1 : 1,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let targets: string[];
  try {
    targets = args.length === 1 && args[0] === "--scan" ? listPolicyFiles() : args;
  } catch (error) {
    console.error(`Prisma query-cast policy could not enumerate inputs: ${String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (targets.length === 0) {
    console.error("Prisma query-cast policy received no TypeScript files.");
    process.exitCode = 2;
    return;
  }
  const violations: Violation[] = [];
  for (const file of targets) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      console.error(
        `${file}: Prisma query-cast policy could not read this file: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
      return;
    }
    try {
      violations.push(...findViolations(source, file));
    } catch (error) {
      const location = parseErrorLocation(error);
      console.error(
        `${file}:${location.line}:${location.column} Prisma query-cast policy could not parse this file: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
      return;
    }
  }
  for (const violation of violations)
    console.error(
      `${violation.file}:${violation.line}:${violation.column} Do not assert a type on a Prisma operation result. Remove the assertion and rely on inference; schema-check reusable query arguments with the appropriate generated Prisma type.`,
    );
  if (violations.length > 0) process.exitCode = 1;
  else console.log(`Prisma query-cast policy passed (${targets.length} files).`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
