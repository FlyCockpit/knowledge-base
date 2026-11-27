import type { MutationObserver, MutationObserverOptions } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChangeList,
  changeListItems,
  GrantEditSheet,
  type GrantEditTarget,
  storedKbOptions,
} from "./grant-edit-sheet";

const fixture = vi.hoisted(() => ({
  active: false,
  scope: "",
  cursor: 0,
  cells: new Map<string, unknown[]>(),
  success: vi.fn(),
  request: vi.fn(),
  mutation: undefined as MutationObserver<unknown, Error, unknown> | undefined,
}));

// A small hook harness lets the actual form and confirmation handlers run in
// one render turn, before React can publish the mutation's pending state.
// Query execution and its success/settlement callbacks use TanStack itself.
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { useState: stateHook, useRef: refHook, useReducer: reducerHook } = actual;
  function cell<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    if (!fixture.active) return stateHook(initial);
    let cells = fixture.cells.get(fixture.scope);
    if (!cells) {
      cells = [];
      fixture.cells.set(fixture.scope, cells);
    }
    const index = fixture.cursor++;
    if (!(index in cells))
      cells[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    const stored = cells;
    return [
      stored[index] as T,
      (next) => {
        stored[index] =
          typeof next === "function" ? (next as (previous: T) => T)(stored[index] as T) : next;
      },
    ];
  }
  return {
    ...actual,
    useState: cell,
    useRef: <T,>(value: T) => (fixture.active ? cell({ current: value })[0] : refHook(value)),
    useReducer: <T, A>(reducer: (state: T, action: A) => T, initial: T) => {
      if (!fixture.active) return reducerHook(reducer, initial);
      const [state, set] = cell(initial);
      return [state, (action: A) => set((previous) => reducer(previous, action))];
    },
  };
});
vi.mock("react-i18next", async (original) => {
  const actual = await original<typeof import("react-i18next")>();
  const translationHook = actual.useTranslation;
  return {
    ...actual,
    useTranslation: (...args: Parameters<typeof actual.useTranslation>) =>
      fixture.active ? { t: (key: string) => key } : translationHook(...args),
  };
});
vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast: { success: fixture.success } }));
vi.mock("@tanstack/react-form", () => ({
  useForm: (options: { onSubmit: () => void }) => ({ handleSubmit: options.onSubmit }),
}));
vi.mock("@/hooks/use-mcp-consent", async (original) => ({
  ...(await original<typeof import("@/hooks/use-mcp-consent")>()),
  useLiveKbOptions: () => ({
    query: { isPending: false },
    live: [{ kbId: "kb1", name: "Notes", bits: ["read", "propose"] }],
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    mcpGrants: {
      key: () => ["grants"],
      listAclMine: { infiniteOptions: () => ({}) },
      updateMine: {
        mutationOptions: (options: object) => ({ ...options, mutationFn: fixture.request }),
      },
    },
    mcpTokens: { key: () => ["tokens"] },
  },
}));
vi.mock("@tanstack/react-query", async (original) => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  const client = new actual.QueryClient();
  return {
    ...actual,
    useQueryClient: () => client,
    useInfiniteQuery: () => ({
      isPending: false,
      isError: false,
      hasNextPage: false,
      data: { pages: [{ items: [{ kbId: "kb1", bits: ["read"] }] }] },
    }),
    useMutation: (options: MutationObserverOptions<unknown, Error, unknown>) => {
      fixture.mutation ??= new actual.MutationObserver(client, options);
      return {
        isPending: false,
        error: null,
        mutate: (input: unknown) => {
          void fixture.mutation!.mutate(input).catch(() => {});
        },
      };
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
const target: GrantEditTarget = {
  grantId: "grant1",
  kind: "PAT",
  name: "Token",
  neverExpires: false,
  activeElevations: 0,
  scopes: ["mcp:read", "mcp:write"],
  toolGroups: ["read", "pull_requests"],
  allowCreate: false,
  createdKbBits: [],
  authoringMode: "both",
};
const closed = vi.fn();
function call(element: Element, scope: string): ReactNode {
  fixture.scope = scope;
  fixture.cursor = 0;
  return (element.type as (props: Record<string, unknown>) => ReactNode)(element.props);
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function renderForm(): Element[] {
  const session = GrantEditSheet({ target, onOpenChange: closed }) as Element;
  let tree = call(session, "session");
  let form = elements(tree).find((element) => element.props.snapshot);
  if (!form) {
    tree = call(session, "session");
    form = elements(tree).find((element) => element.props.snapshot);
  }
  if (!form) throw new Error("Missing grant form");
  return elements(call(form, "form"));
}
function confirm(): () => void {
  fixture.active = true;
  let form = renderForm();
  const duration = form.find((element) => element.props.value === "permanent")!;
  (duration.props.onChange as (value: string) => void)("1h");
  const picker = form.find((element) => element.props.selection)!;
  (picker.props.onChange as (action: object) => void)({
    type: "toggleBit",
    kbId: "kb1",
    bit: "propose",
  });
  form = renderForm();
  (form.find((element) => element.type === "form")!.props.onSubmit as (event: object) => void)({
    preventDefault() {},
    stopPropagation() {},
  });
  const confirmation = renderForm().find(
    (element) => element.props.children === "settings:credentials.edit.confirmSubmit",
  );
  if (!confirmation) throw new Error("Missing confirmation button");
  return confirmation.props.onClick as () => void;
}

beforeEach(() => {
  fixture.active = false;
  fixture.cells.clear();
  fixture.mutation = undefined;
  fixture.request.mockReset();
  fixture.success.mockClear();
  closed.mockClear();
});

describe("temporary grant confirmation", () => {
  it("sends one request and one success toast for duplicate confirmation before pending paint", async () => {
    let finish!: (value: unknown) => void;
    fixture.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const click = confirm();
    click();
    click();
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1));
    expect(fixture.request.mock.calls[0]![0]).toMatchObject({ id: "grant1", duration: "1h" });
    finish({});
    await vi.waitFor(() => expect(fixture.mutation?.getCurrentResult().status).toBe("success"));
    expect(fixture.success).toHaveBeenCalledExactlyOnceWith(
      "settings:credentials.edit.savedTemporary",
    );
    expect(closed).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("allows a new confirmation after a failed request settles", async () => {
    fixture.request.mockRejectedValueOnce(new Error("retry")).mockResolvedValueOnce({});
    const click = confirm();
    click();
    await vi.waitFor(() => expect(fixture.mutation?.getCurrentResult().status).toBe("error"));
    expect(fixture.success).not.toHaveBeenCalled();
    click();
    await vi.waitFor(() => expect(fixture.mutation?.getCurrentResult().status).toBe("success"));
    expect(fixture.request).toHaveBeenCalledTimes(2);
    expect(fixture.success).toHaveBeenCalledTimes(1);
  });
});

import { MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import enSettings from "@knowledge-base/locales/src/en-US/settings.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { AclPicker } from "@/components/kb/acl-picker";

import { type LiveKbOption, selectionReducer } from "@/hooks/use-mcp-consent";
import { grantEditPlan, selectionFromGrant } from "@/lib/mcp-grant-edit";

const KB_A = "a".repeat(24);
const KB_B = "b".repeat(24);

describe("Edit access confirmation", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["settings"],
      defaultNS: "settings",
      resources: { "en-US": { settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  const plan = () => {
    const baseline = selectionFromGrant({
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: KB_A, bits: ["read"] }],
      allowCreate: false,
      createdKbBits: [],
      authoringMode: null,
    });
    const draft = [
      { type: "toggleScope", scope: "mcp:write" },
      { type: "setAuthoringMode", mode: "edit" },
      { type: "setToolGroups", groups: [...MCP_TOOL_PRESETS.direct] },
      { type: "toggleBit", kbId: KB_A, bit: "write" },
      { type: "toggleBit", kbId: KB_B, bit: "read" },
      { type: "setAllowCreate", value: true },
      { type: "toggleCreatedBit", bit: "read" },
    ].reduce(
      (state, action) => selectionReducer(state, action as Parameters<typeof selectionReducer>[1]),
      baseline,
    );
    return grantEditPlan(baseline, draft, {
      scopesEditable: true,
      touched: new Set([KB_A, KB_B]),
    });
  };
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("lists exactly what is added, with KB names when known and never a raw id", () => {
    const markup = render(
      <ChangeList
        direction="added"
        changes={plan().added}
        names={new Map([[KB_A, "Alpha notes"]])}
      />,
    );
    const edit = enSettings.credentials.edit;
    const bits = enSettings.credentials.picker.bits;
    expect(markup).toContain(edit.added);
    expect(markup).toContain(enSettings.credentials.picker.scopes.write);
    expect(markup).toContain(edit.changeWriteMode.edit);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.edit.label} tools`);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.assets.label} tools`);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.pull_requests.label} tools`);
    expect(markup).toContain(`Alpha notes: ${bits.propose.label}, ${bits.write.label}`);
    expect(markup).toContain(`${enSettings.credentials.kbUnavailable}: ${bits.read.label}`);
    expect(markup).not.toContain(KB_B);
    expect(markup).toContain(edit.changeCreate);
    expect(markup).toContain(bits.read.label);
    expect(markup).toContain(`${enSettings.credentials.picker.groups.kb_admin.label} tools`);
    // Nothing already held is listed: scope, write mode, four groups (Direct's
    // edit, assets and pull_requests; kb_admin comes with create), two KBs,
    // create, created bits.
    expect(markup.match(/<li>/g)).toHaveLength(10);
  });

  it("lists two unavailable KBs with the same change once each, keyed apart", () => {
    const changes = {
      scopes: [],
      toolGroups: [],
      kbs: [
        { kbId: KB_A, bits: ["read" as const] },
        { kbId: KB_B, bits: ["read" as const] },
      ],
      cap: null,
      allowCreate: false,
      createdKbBits: [],
      authoringMode: [],
    };
    const line = `${enSettings.credentials.kbUnavailable}: ${enSettings.credentials.picker.bits.read.label}`;
    const items = changeListItems(changes, new Map(), i18n.getFixedT("en-US", "settings"));
    expect(items.map((item) => item.text)).toEqual([line, line]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
    const markup = render(<ChangeList direction="removed" changes={changes} names={new Map()} />);
    expect(markup.split(`<li>${line}</li>`)).toHaveLength(3);
    expect(markup).not.toContain(KB_A);
    expect(markup).not.toContain(KB_B);
  });

  it("renders nothing when a direction has no changes", () => {
    expect(
      render(<ChangeList direction="removed" changes={plan().removed} names={new Map()} />),
    ).toBe("");
  });

  it("summarizes a preset cap instead of listing every knowledge base", () => {
    const markup = render(
      <ChangeList
        direction="removed"
        changes={{
          scopes: [],
          toolGroups: [],
          kbs: [],
          cap: { bits: ["read"], count: 257 },
          allowCreate: false,
          createdKbBits: [],
          authoringMode: [],
        }}
        names={new Map()}
      />,
    );
    expect(markup).toContain("Every knowledge base limited to: Read");
    expect(markup).toContain("257 knowledge bases");
  });
});

describe("Edit access: stored permissions without live authority", () => {
  const i18n = createInstance();
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["settings"],
      defaultNS: "settings",
      resources: { "en-US": { settings: enSettings } },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });
  const KB_REVOKED = "r".repeat(24);
  const KB_DOWN = "d".repeat(24);
  const snapshot = selectionFromGrant({
    scopes: ["mcp:write"],
    toolGroups: ["read", "edit"],
    acl: [
      { kbId: KB_REVOKED, bits: ["read"] },
      { kbId: KB_DOWN, bits: ["read", "propose", "write"] },
    ],
    allowCreate: false,
    createdKbBits: [],
    authoringMode: "both",
  });
  // The share on KB_DOWN was downgraded to read; KB_REVOKED is no longer shared at all.
  const live: LiveKbOption[] = [{ kbId: KB_DOWN, name: "Downgraded notes", bits: ["read"] }];

  it("offers every stored entry, marking bits the user no longer holds as removal-only", () => {
    const { options, removalOnly } = storedKbOptions(
      snapshot,
      live,
      enSettings.credentials.kbUnavailable,
    );
    expect(options).toEqual([
      { kbId: KB_DOWN, name: "Downgraded notes", bits: ["read", "propose", "write"] },
      { kbId: KB_REVOKED, name: enSettings.credentials.kbUnavailable, bits: ["read"] },
    ]);
    expect(removalOnly).toEqual({ [KB_REVOKED]: ["read"], [KB_DOWN]: ["propose", "write"] });
  });

  const picker = (selection: typeof snapshot) => {
    const { options, removalOnly } = storedKbOptions(
      snapshot,
      live,
      enSettings.credentials.kbUnavailable,
    );
    return renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <AclPicker
          live={options}
          selection={selection}
          onChange={() => undefined}
          removalOnly={removalOnly}
          scopeMode="select"
          writeScopeSelected
        />
      </I18nextProvider>,
    );
  };
  const box = (markup: string, kbId: string, bit: string) => {
    const match = new RegExp(`<[^>]*id="[^"]*-kb-${kbId}-${bit}"[^>]*>`).exec(markup);
    expect(match, `${kbId}/${bit}`).not.toBeNull();
    return match![0];
  };

  it("shows the revoked share and the downgraded bits checked and removable", () => {
    const markup = picker(snapshot);
    expect(markup).toContain(
      `<legend class="max-w-full truncate px-1 text-sm font-medium">${enSettings.credentials.kbUnavailable}</legend>`,
    );
    expect(markup).toContain(enSettings.credentials.picker.kbUnavailable);
    // The id survives only in DOM id references, never as visible or accessible text.
    expect(markup.replace(/(id|for|aria-labelledby|aria-describedby)="[^"]*"/g, "")).not.toContain(
      KB_REVOKED,
    );
    expect(markup).toContain(enSettings.credentials.picker.removalOnly);
    for (const [kbId, bit] of [
      [KB_REVOKED, "read"],
      [KB_DOWN, "propose"],
      [KB_DOWN, "write"],
    ] as const) {
      expect(box(markup, kbId, bit)).not.toMatch(/disabled/);
    }
  });

  it("once removed, a stale bit cannot be added back; live bits stay editable", () => {
    const removed = [
      { type: "toggleBit", kbId: KB_DOWN, bit: "write" },
      { type: "toggleBit", kbId: KB_REVOKED, bit: "read" },
    ].reduce(
      (state, action) => selectionReducer(state, action as Parameters<typeof selectionReducer>[1]),
      snapshot,
    );
    const markup = picker(removed);
    expect(box(markup, KB_DOWN, "write")).toMatch(/disabled/);
    expect(box(markup, KB_REVOKED, "read")).toMatch(/disabled/);
    expect(box(markup, KB_DOWN, "read")).not.toMatch(/disabled/);
    const result = grantEditPlan(snapshot, removed, {
      scopesEditable: true,
      touched: new Set([KB_DOWN, KB_REVOKED]),
    });
    expect(result.input.acl).toEqual([
      { kbId: KB_DOWN, bits: ["read", "propose"] },
      { kbId: KB_REVOKED, bits: [] },
    ]);
    expect(result.widens).toBe(false);
  });
});
