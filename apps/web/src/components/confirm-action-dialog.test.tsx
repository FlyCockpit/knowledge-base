import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import esAdmin from "@knowledge-base/locales/src/es-MX/admin.json";
import esCommon from "@knowledge-base/locales/src/es-MX/common.json";
import { createInstance } from "i18next";
import type { ReactNode, RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// No browser/DOM dependency: render the real route and dialog with inert UI
// primitives, drive their captured event handlers, then render the next state.
// These tests assert props and markup only, not browser focus movement, focus
// restoration, Escape/backdrop dispatch, or measured viewport fit.
type Control = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  ref?: RefObject<HTMLButtonElement | null>;
};
type MutationOptions = {
  mutationKey: [string, ...string[]];
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
  meta?: { skipGlobalErrorToast?: boolean };
};
const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  buttons: [] as Control[],
  items: [] as Control[],
  dialog: undefined as { open: boolean; onOpenChange: (open: boolean) => void } | undefined,
  popup: undefined as { initialFocus: unknown; showCloseButton: boolean } | undefined,
  role: { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null as Error | null },
  success: undefined as (() => void) | undefined,
  mutations: {} as Record<string, MutationOptions>,
  user: {
    id: "target-id",
    name: "Ana García",
    email: "ana@example.com",
    role: "user",
    emailVerified: true,
    invitePending: false,
    banned: false,
    banReason: null,
    createdAt: "2026-01-01T00:00:00Z",
  },
}));
const i18n = createInstance();
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.states)) fixture.states[index] = initial;
    return [
      fixture.states[index],
      (next: unknown) => {
        fixture.states[index] = next;
      },
    ];
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: (ns: string | string[]) => ({ t: i18n.getFixedT(null, ns), i18n }),
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useRouteContext: () => ({ session: { user: { id: "actor-id" } } }),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useInfiniteQuery: () => ({ data: { pages: [{ users: [fixture.user], nextCursor: null }] } }),
  useMutation: (options: MutationOptions) => {
    fixture.mutations[options.mutationKey[0]] = options;
    return { mutate: vi.fn(), isPending: false };
  },
}));
vi.mock("@tanstack/react-form", () => ({
  useForm: () => ({ Field: () => null, Subscribe: () => null }),
}));
vi.mock("@/utils/orpc", () => {
  const mutation = (key: string) => ({
    mutationOptions: (options = {}) => ({ ...options, mutationKey: [key] }),
  });
  return {
    orpc: {
      users: {
        key: () => ["users"],
        list: { infiniteOptions: () => ({}) },
        setRole: mutation("setRole"),
        archive: mutation("archive"),
        unarchive: mutation("unarchive"),
        remove: mutation("remove"),
        resendInvite: mutation("resendInvite"),
        invite: mutation("invite"),
      },
    },
  };
});
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: (options: MutationOptions) => {
    fixture.mutations[options.mutationKey[0]] = options;
    if (options.mutationKey[0] === "setRole") {
      fixture.success = options.onSuccess;
      return fixture.role;
    }
    return { mutate: vi.fn(), isPending: false };
  },
}));
vi.mock("@knowledge-base/ui/hooks/use-async-search", () => ({
  useDebounce: (value: string) => value,
}));
vi.mock("@knowledge-base/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/hooks/archive-undo", () => ({ announceArchivedWithUndo: vi.fn() }));
vi.mock("@/utils/friendly-error", () => ({ friendly: vi.fn(() => "Unexpected error") }));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));
vi.mock("@/components/page-shell", () => ({
  PageHeader: () => null,
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/query-boundary", () => ({
  QueryBoundary: ({ children }: { children: () => ReactNode }) => children(),
}));
vi.mock("@/components/load-more", () => ({ LoadMore: () => null }));
vi.mock("@/components/segmented-control", () => ({ SegmentedControl: () => null }));
vi.mock("@knowledge-base/ui/components/button", () => ({
  Button: (props: Control) => {
    fixture.buttons.push(props);
    return (
      <button type="button" disabled={props.disabled} className={props.className}>
        {props.children}
      </button>
    );
  },
}));
vi.mock("@knowledge-base/ui/components/dropdown-menu", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Part,
    DropdownMenuContent: Part,
    DropdownMenuTrigger: Part,
    DropdownMenuItem: (props: Control) => {
      fixture.items.push(props);
      return <div>{props.children}</div>;
    },
  };
});
vi.mock("@knowledge-base/ui/components/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      // Ignore the closed invite/reveal dialogs when inspecting the role dialog.
      fixture.dialog = props;
      return props.open ? <div role="dialog">{props.children}</div> : null;
    },
    DialogContent: (props: {
      initialFocus: unknown;
      showCloseButton: boolean;
      children: ReactNode;
    }) => {
      fixture.popup = props;
      return <div>{props.children}</div>;
    },
    DialogHeader: Part,
    DialogTitle: Part,
    DialogDescription: Part,
    DialogFooter: Part,
  };
});

vi.mock("@knowledge-base/ui/components/alert-dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    AlertDialog: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      fixture.dialog = props;
      return props.open ? <div role="alertdialog">{props.children}</div> : null;
    },
    AlertDialogContent: Part,
    AlertDialogHeader: Part,
    AlertDialogTitle: Part,
    AlertDialogDescription: Part,
    AlertDialogFooter: Part,
    AlertDialogAction: (props: Control) => {
      fixture.buttons.push(props);
      return <button type="button">{props.children}</button>;
    },
    AlertDialogCancel: (props: Control) => <button type="button">{props.children}</button>,
  };
});
const { Route } = await import("@/routes/$lang/_app/admin/users");
const component = Route.options.component as unknown as {
  importer: () => Promise<Record<string, unknown>>;
  name: string;
};
const Page = (await component.importer())[component.name] as () => ReactNode;

function render() {
  fixture.cursor = 0;
  fixture.buttons = [];
  fixture.items = [];
  fixture.popup = undefined;
  const Component = Page;
  if (!Component) throw new Error("Missing users route component");
  return renderToStaticMarkup(<Component />);
}
function label(control: Control) {
  return renderToStaticMarkup(control.children);
}
function button(text: string) {
  const found = fixture.buttons.find((control) => label(control) === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function openRoleDialog() {
  render();
  const menuText = i18n.t(
    fixture.user.role === "admin" ? "admin:users.demoteToUser" : "admin:users.promoteToAdmin",
  );
  const item = fixture.items.find((control) => label(control).includes(menuText));
  if (!item) throw new Error("Missing role menu item");
  item.onClick?.();
  return render();
}

describe("existing admin access confirmation", () => {
  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      defaultNS: "admin",
      resources: {
        "en-US": { admin: enAdmin, common: enCommon },
        "es-MX": { admin: esAdmin, common: esCommon },
      },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(() => {
    fixture.states = [];
    fixture.role.mutate.mockClear();
    fixture.user.name = "Ana García";
  });
  it.each(["en-US", "es-MX"])(
    "names the user and requires confirmation for promotion and demotion in %s",
    async (lang) => {
      await i18n.changeLanguage(lang);
      for (const role of ["user", "admin"]) {
        fixture.states = [];
        fixture.user.role = role;
        fixture.role.mutate.mockClear();
        const html = openRoleDialog();
        expect(html).toContain('role="alertdialog"');
        expect(html).toContain("Ana García");
        expect(fixture.role.mutate).not.toHaveBeenCalled();
        button(i18n.t(role === "user" ? "users.promoteToAdmin" : "users.demoteToUser")).onClick?.();
        expect(fixture.role.mutate).toHaveBeenCalledExactlyOnceWith({
          userId: "target-id",
          role: role === "user" ? "admin" : "user",
        });
        expect(render()).not.toContain('role="alertdialog"');
      }
    },
  );
  it("cancels without sending a role write", () => {
    fixture.user.role = "user";
    openRoleDialog();
    fixture.dialog?.onOpenChange(false);
    expect(render()).not.toContain('role="alertdialog"');
    expect(fixture.role.mutate).not.toHaveBeenCalled();
  });
});
