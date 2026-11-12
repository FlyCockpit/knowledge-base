import { kbDescriptionSchema, kbNameSchema } from "@knowledge-base/api/lib/schemas";
import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextareaField, TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import type * as React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { StatusPill } from "@/components/status-pill";
import {
  clearKbPrivateQueries,
  isAccessLoss,
  kbControls,
  recheckKbAccess,
} from "@/hooks/use-kb-editor";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { usePayloadAttemptKey } from "@/hooks/use-payload-attempt-key";
import { orpc } from "@/utils/orpc";

export type KbItem = Awaited<ReturnType<AppRouterClient["kbs"]["list"]>>["items"][number];

export const kbHref = (lang: string, kbId: string) =>
  `/${encodeURIComponent(lang)}/kbs/${encodeURIComponent(kbId)}`;

/** After create, the returned effective bits decide whether the new KB can be opened. */
export function createdKbDestination(kb: Pick<KbItem, "capabilities">): "open" | "stay" {
  return kbControls(kb.capabilities).canRead ? "open" : "stay";
}

export type KbErrorAction = "conflict" | "accessLost" | "forbidden" | "error";
export function kbMutationErrorAction(error: unknown): KbErrorAction {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CONFLICT") return "conflict";
  if (code === "FORBIDDEN") return "forbidden";
  if (isAccessLoss(error)) return "accessLost";
  return "error";
}

/** The access line under a KB: the owner reads "Owner", anyone else how their edits land. */
export function kbAccessLabelKey(kb: Pick<KbItem, "isOwner" | "writeMode">): string {
  return kb.isOwner ? "access.owner" : `writeMode.${kb.writeMode}`;
}

/** Plain left-clicks go through the SPA router; modified clicks keep native link behavior. */
export function routerClick(open: (() => void) | undefined) {
  return (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!open || event.defaultPrevented || event.button !== 0) return;
    if (event.currentTarget.target && event.currentTarget.target !== "_self") return;
    if (event.currentTarget.hasAttribute("download")) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open();
  };
}

/** KBs as the server returns them (one relation per list); nothing here enumerates ungranted KBs. */
export function KbList({
  lang,
  items,
  onOpen,
  emptyTitle,
  emptyDescription,
}: {
  lang: string;
  items: readonly KbItem[];
  onOpen?: (kbId: string) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t } = useTranslation("kb");
  if (items.length === 0) {
    return (
      <EmptyState
        title={emptyTitle ?? t("list.emptyTitle")}
        description={emptyDescription ?? t("list.emptyDescription")}
      />
    );
  }
  return (
    <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
      {items.map((kb) => (
        <li key={kb.id} data-owner={kb.isOwner ? "true" : "false"} className="min-w-0">
          <a
            href={kbHref(lang, kb.id)}
            onClick={routerClick(onOpen && (() => onOpen(kb.id)))}
            className="flex h-full min-h-[44px] flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[background-color,box-shadow] hover:bg-muted/40 hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <BookOpen className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block truncate font-medium">{kb.name}</span>
                <span className="line-clamp-2 block text-sm text-muted-foreground">
                  {kb.description}
                </span>
              </span>
            </span>
            <span className="mt-auto flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 truncate font-mono">{kb.slug}</span>
              <StatusPill tone={kb.isOwner ? "info" : "muted"}>
                {t(kbAccessLabelKey(kb))}
              </StatusPill>
              <StatusPill tone={kb.embeddingGeneration ? "good" : "muted"}>
                {t(kb.embeddingGeneration ? "list.searchable" : "list.notSearchable")}
              </StatusPill>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Edit needs `manage`; delete is owner-only, so a manager who is not
 * the owner never sees it. The server enforces both regardless.
 */
export function KbManageActions({
  kb,
  onEdit,
  onDelete,
}: {
  kb: Pick<KbItem, "capabilities" | "isOwner">;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("kb");
  if (!kbControls(kb.capabilities).canManage) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button data-testid="kb-edit" variant="outline" className="min-h-[44px]" onClick={onEdit}>
        {t("manage.edit")}
      </Button>
      {kb.isOwner && (
        <Button
          data-testid="kb-delete"
          variant="destructive"
          className="min-h-[44px]"
          onClick={onDelete}
        >
          {t("manage.delete")}
        </Button>
      )}
    </div>
  );
}

const createdKbSchema = z.object({
  kb: z.object({
    id: z.string(),
    capabilities: z.array(z.enum(["read", "propose", "write", "review", "manage"])),
  }),
});

const SLUG_MAX = 63;

/**
 * The slug suggested for a name: lowercase ASCII letters and digits joined by
 * single hyphens (accents are folded, everything else separates words).
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");
}

export const createSchema = z.object({
  name: z.string().trim().pipe(kbNameSchema),
  slug: z
    .string()
    // An empty slug says "required" once, not also "format is invalid".
    .min(1, { abort: true })
    .max(SLUG_MAX)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  description: z.string().trim().pipe(kbDescriptionSchema),
});

export function KbCreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (kb: Pick<KbItem, "id" | "capabilities">) => void;
}) {
  // Each opening owns its form, attempt memory and mutation observer.
  return props.open ? <KbCreateSession {...props} /> : null;
}

function KbCreateSession({
  open,
  onOpenChange,
  onCreated,
}: React.ComponentProps<typeof KbCreateDialog>) {
  const { t } = useTranslation(["kb", "common"]);
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const attempt = usePayloadAttemptKey();
  // The name the current slug was derived from; a slug that no longer matches it was typed.
  const derivedFrom = useRef("");
  const create = useMutation(
    orpc.kbs.create.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() });
        if (!session.current) return;
        attempt.settle();
        close(false);
        const created = createdKbSchema.safeParse(result);
        if (created.success) onCreated(created.data.kb);
      },
    }),
  );
  const form = useForm({
    defaultValues: { name: "", slug: "", description: "" },
    validators: { onSubmit: createSchema },
    onSubmit: ({ value }) => {
      const payload = {
        name: value.name.trim(),
        slug: value.slug,
        description: value.description.trim(),
      };
      create.mutate({ ...payload, idempotencyKey: attempt.keyFor(payload) });
    },
  });
  function close(next: boolean) {
    if (next) return onOpenChange(true);
    session.current = false;
    create.reset();
    form.reset();
    attempt.settle();
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("kb:create.title")}</DialogTitle>
          <DialogDescription>{t("kb:create.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field
            name="name"
            listeners={{
              // The slug follows the name until the user types their own.
              onChange: ({ value }) => {
                const slug = form.getFieldValue("slug");
                if (slug === "" || slug === slugFromName(derivedFrom.current))
                  form.setFieldValue("slug", slugFromName(value));
                derivedFrom.current = value;
              },
            }}
          >
            {(field) => (
              <TextField
                field={field}
                label={t("kb:create.name")}
                autoComplete="off"
                inputMode="text"
                // HTML counts UTF-16 units; allow two per scalar and let the schema enforce 120.
                maxLength={240}
              />
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <TextField
                field={field}
                label={t("kb:create.slug")}
                description={t("kb:create.slugHint")}
                autoComplete="off"
                inputMode="url"
                maxLength={SLUG_MAX}
              />
            )}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <TextareaField
                field={field}
                label={t("kb:create.descriptionLabel")}
                description={t("kb:create.descriptionHint")}
                autoComplete="off"
                maxLength={4000}
              />
            )}
          </form.Field>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("kb:create.error")}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              onClick={() => close(false)}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" className="min-h-[44px]" disabled={create.isPending}>
              {create.isPending ? t("kb:create.submitting") : t("kb:create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export const metadataSchema = z.object({
  name: createSchema.shape.name,
  description: createSchema.shape.description,
});

/** Edit → Sheet. Pinned to the metadataVersion it was opened with; a conflict refetches. */
export function KbMetadataSheet(props: {
  kb: Pick<KbItem, "id" | "name" | "description" | "metadataVersion">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return props.open ? <KbMetadataSession key={props.kb.id} {...props} /> : null;
}

function KbMetadataSession({
  kb,
  open,
  onOpenChange,
}: React.ComponentProps<typeof KbMetadataSheet>) {
  const { t } = useTranslation(["kb", "common"]);
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const [snapshot] = useState(kb);
  const attempt = usePayloadAttemptKey();
  const [conflict, setConflict] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.kbs.get.key({ input: { kbId: kb.id } }) }),
      queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() }),
    ]);
  const update = useMutation(
    orpc.kbs.update.mutationOptions({
      onSuccess: async () => {
        await refresh();
        if (!session.current) return;
        attempt.settle();
        toast.success(t("kb:manage.saved"));
        session.current = false;
        onOpenChange(false);
      },
      onError: async (error) => {
        const action = kbMutationErrorAction(error);
        if (action === "error") return;
        if (action === "conflict") {
          if (session.current) {
            attempt.settle();
            setConflict(true);
          }
          await refresh();
        } else {
          // Denied: re-check the KB permission; only an actual loss clears data.
          if (session.current) {
            attempt.settle();
            session.current = false;
            onOpenChange(false);
          }
          await recheckKbAccess(queryClient, kb.id);
        }
      },
    }),
  );
  const form = useForm({
    defaultValues: { name: snapshot.name, description: snapshot.description },
    validators: { onSubmit: metadataSchema },
    onSubmit: ({ value }) => {
      const payload = {
        kbId: kb.id,
        metadataVersion: snapshot.metadataVersion,
        name: value.name.trim(),
        description: value.description.trim(),
      };
      setConflict(false);
      update.mutate({ ...payload, idempotencyKey: attempt.keyFor(payload) });
    },
  });
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          session.current = false;
          form.reset();
          update.reset();
          setConflict(false);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="overflow-y-auto overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{t("kb:manage.editTitle")}</SheetTitle>
          <SheetDescription>{t("kb:manage.editDescription")}</SheetDescription>
        </SheetHeader>
        <form
          className="min-w-0 space-y-4 px-4"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <TextField
                field={field}
                label={t("kb:create.name")}
                autoComplete="off"
                inputMode="text"
                maxLength={240}
              />
            )}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <TextareaField
                field={field}
                label={t("kb:create.descriptionLabel")}
                autoComplete="off"
                maxLength={4000}
              />
            )}
          </form.Field>
          {conflict && (
            <p role="alert" className="text-sm text-destructive">
              {t("kb:manage.conflict")}
            </p>
          )}
          {update.isError && !conflict && (
            <p role="alert" className="text-sm text-destructive">
              {t("kb:manage.error")}
            </p>
          )}
          <SheetFooter className="px-0">
            <Button type="submit" className="min-h-[44px]" disabled={update.isPending || conflict}>
              {update.isPending ? t("kb:manage.saving") : t("kb:manage.save")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Delete → AlertDialog with typed DELETE. The server enforces owner + manage. */
export function KbDeleteDialog(props: {
  kb: Pick<KbItem, "id" | "name" | "metadataVersion">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  return props.open ? <KbDeleteSession key={props.kb.id} {...props} /> : null;
}

function KbDeleteSession({
  kb,
  open,
  onOpenChange,
  onDeleted,
}: React.ComponentProps<typeof KbDeleteDialog>) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const attempt = usePayloadAttemptKey();
  const remove = useMutation(
    orpc.kbs.delete.mutationOptions({
      onSuccess: async (_result, variables) => {
        clearKbPrivateQueries(queryClient, variables.kbId);
        await queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() });
        if (!session.current) return;
        attempt.settle();
        toast.success(t("manage.deleted"));
        session.current = false;
        onDeleted();
      },
      onError: async (error, variables) => {
        const action = kbMutationErrorAction(error);
        if (action === "error") return;
        const active = session.current;
        if (active) {
          attempt.settle();
          session.current = false;
          onOpenChange(false);
        }
        if (action === "conflict") {
          if (active) toast.error(t("manage.conflict"));
          await queryClient.invalidateQueries({
            queryKey: orpc.kbs.get.key({ input: { kbId: variables.kbId } }),
          });
          return;
        }
        if (active && action === "forbidden") toast.error(t("manage.deleteForbidden"));
        // Refused (e.g. ownership moved): re-derive isOwner/bits from a fresh
        // permission check; the KB's data is cleared only if read access is gone.
        await recheckKbAccess(queryClient, variables.kbId);
      },
    }),
  );
  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) session.current = false;
        onOpenChange(next);
      }}
      title={t("manage.deleteTitle", { name: kb.name })}
      description={
        <>
          {t("manage.deleteDescription")}
          {remove.isError && kbMutationErrorAction(remove.error) === "error" && (
            <span role="alert" className="mt-2 block text-destructive">
              {t("manage.deleteError")}
            </span>
          )}
        </>
      }
      confirmToken="DELETE"
      typePrompt={t("manage.deletePrompt")}
      copyAriaLabel={t("manage.copyToken")}
      isPending={remove.isPending}
      onConfirm={(value) => {
        if (value !== "DELETE") return;
        const payload = {
          kbId: kb.id,
          metadataVersion: kb.metadataVersion,
          confirm: "DELETE" as const,
        };
        remove.mutate({ ...payload, idempotencyKey: attempt.keyFor(payload) });
      }}
    />
  );
}
