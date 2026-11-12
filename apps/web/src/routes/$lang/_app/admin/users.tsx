import { hasRole } from "@knowledge-base/auth/roles";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@knowledge-base/ui/components/dropdown-menu";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { SelectItem } from "@knowledge-base/ui/components/select";
import { toast } from "@knowledge-base/ui/components/sileo";
import { SelectField, TextField } from "@knowledge-base/ui/components/text-field";
import { useDebounce } from "@knowledge-base/ui/hooks/use-async-search";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, MoreVertical, Plus, Shield, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { SkeletonList } from "@/components/skeleton-list";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

type StatusFilter = "all" | "active" | "archived";

const PAGE_LIMIT = 50;

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  banned: boolean | null;
  banReason: string | null;
  createdAt: Date | string;
};

function buildInviteSchema() {
  return z.object({
    email: z.email(),
    name: z.string().trim().min(1).max(100),
    role: z.enum(["user", "admin"]),
  });
}

/** What the admin sees after an invite; the link only when it was not emailed. */
type InviteReveal = { email: string; emailSent: boolean; setPasswordUrl?: string };

export const Route = createFileRoute("/$lang/_app/admin/users")({
  head: ({ match }) =>
    pageHead(match.context.i18n.t("admin:nav.users"), match.context.i18n.t("nav:items.admin")),
  component: AdminUsers,
});

function AdminUsers() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["admin", "common"]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reveal, setReveal] = useState<InviteReveal | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // Promote, demote and archive confirm first (R2-7); restore is one click.
  const [pendingAction, setPendingAction] = useState<{
    kind: "promote" | "demote" | "archive";
    user: UserRow;
  } | null>(null);
  const debouncedSearch = useDebounce(search.trim(), 300);

  const listQuery = useInfiniteQuery(
    orpc.users.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE_LIMIT,
        cursor,
        search: debouncedSearch || undefined,
        status: statusFilter,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );

  const setRole = useEntityMutation(
    {
      ...orpc.users.setRole.mutationOptions(),
      meta: { errorFallbackKey: "admin:users.roleUpdateFailed" },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.roleUpdated") },
  );

  const archive = useEntityMutation(
    {
      ...orpc.users.archive.mutationOptions(),
      meta: { errorFallbackKey: "admin:users.archiveFailed" },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.userArchived") },
  );

  const unarchive = useEntityMutation(
    {
      ...orpc.users.unarchive.mutationOptions(),
      meta: { errorFallbackKey: "admin:users.restoreFailed" },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.userRestored") },
  );

  const remove = useEntityMutation(
    {
      ...orpc.users.remove.mutationOptions({
        onSuccess: () => {
          setDeleteId(null);
        },
      }),
      meta: { errorFallbackKey: "admin:users.deleteFailed" },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.userDeleted") },
  );

  // Status is filtered server-side (see users.list), so every loaded row
  // already matches the active tab. Emptiness and pagination are decided on the
  // server result, never on a client-side slice of the pages we happen to hold.
  const allUsers = (listQuery.data?.pages.flatMap((page) => page.users) ?? []) as UserRow[];
  const deleteTarget = allUsers.find((u) => u.id === deleteId) ?? null;

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("admin:users.title")}
        description={t("admin:users.description")}
        actions={
          <Button
            onClick={() => {
              setInviteOpen(true);
            }}
            className="min-h-[44px]"
          >
            <Plus className="size-4" /> {t("admin:users.invite")}
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          value={statusFilter}
          onChange={setStatusFilter}
          items={[
            { value: "all", label: t("admin:users.tabAll") },
            { value: "active", label: t("admin:users.tabActive") },
            { value: "archived", label: t("admin:users.tabArchived") },
          ]}
        />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          aria-label={t("admin:users.searchLabel")}
          placeholder={t("admin:users.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin:users.allUsers")}</CardTitle>
          <CardDescription>
            {listQuery.isPending
              ? t("admin:users.loading")
              : listQuery.isError
                ? t("admin:users.loadFailedShort")
                : t("admin:users.shownCount", {
                    count: allUsers.length,
                    shown: allUsers.length,
                  })}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <QueryBoundary
            query={listQuery}
            skeleton={<SkeletonList count={6} />}
            errorMessage={t("admin:users.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.users.length === 0)}
            empty={
              <EmptyState
                title={
                  search.trim()
                    ? t("admin:users.noMatch")
                    : statusFilter === "archived"
                      ? t("admin:users.noArchived")
                      : statusFilter === "active"
                        ? t("admin:users.noActive")
                        : t("admin:users.noUsersYet")
                }
                description={
                  search.trim() ? t("admin:users.tryDifferentQuery") : t("admin:users.inviteFirst")
                }
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {/* `allUsers` is the same flattened pages QueryBoundary just
                      vouched for — flattened once, above. */}
                  {allUsers.map((user) => {
                    const isSelf = user.id === session.user.id;
                    const isAdmin = hasRole(user.role, "admin");
                    const isArchived = !!user.banned;
                    return (
                      <li
                        key={user.id}
                        className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span className="truncate">{user.name || user.email}</span>
                            {isSelf && (
                              <span className="rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                                {t("admin:users.youBadge")}
                              </span>
                            )}
                            <RolePill isAdmin={isAdmin} />
                            {isArchived && <ArchivedPill />}
                            {!user.emailVerified && <UnverifiedPill />}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {user.email} · {t("admin:users.joined")}{" "}
                            <time dateTime={new Date(user.createdAt).toISOString()}>
                              {new Date(user.createdAt).toLocaleDateString()}
                            </time>
                            {user.banReason ? ` · ${user.banReason}` : ""}
                          </p>
                        </div>
                        <UserActions
                          user={user}
                          isSelf={isSelf}
                          isAdmin={isAdmin}
                          isArchived={isArchived}
                          onSetRole={(role) => {
                            setPendingAction({
                              kind: role === "admin" ? "promote" : "demote",
                              user,
                            });
                          }}
                          onArchive={() => {
                            setPendingAction({ kind: "archive", user });
                          }}
                          onUnarchive={() => {
                            unarchive.mutate({ userId: user.id });
                          }}
                          onDelete={() => {
                            setDeleteId(user.id);
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
                <LoadMore
                  hasNextPage={listQuery.hasNextPage}
                  isFetchingNextPage={listQuery.isFetchingNextPage}
                  onLoadMore={() => void listQuery.fetchNextPage()}
                />
              </>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(payload) => {
          setInviteOpen(false);
          setReveal(payload);
          queryClient.invalidateQueries({ queryKey: orpc.users.key() });
        }}
      />

      <RevealInviteDialog reveal={reveal} onClose={() => setReveal(null)} />

      <ConfirmActionDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        title={
          pendingAction
            ? t(`admin:users.confirm.${pendingAction.kind}Title`, {
                name: pendingAction.user.name || pendingAction.user.email,
              })
            : ""
        }
        description={pendingAction ? t(`admin:users.confirm.${pendingAction.kind}Description`) : ""}
        confirmLabel={
          pendingAction?.kind === "promote"
            ? t("admin:users.promoteToAdmin")
            : pendingAction?.kind === "demote"
              ? t("admin:users.demoteToUser")
              : t("admin:users.archiveUser")
        }
        destructive={pendingAction?.kind !== "promote"}
        onConfirm={() => {
          if (!pendingAction) return;
          const userId = pendingAction.user.id;
          if (pendingAction.kind === "archive") archive.mutate({ userId });
          else
            setRole.mutate({ userId, role: pendingAction.kind === "promote" ? "admin" : "user" });
          setPendingAction(null);
        }}
      />

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
        title={t("admin:users.deleteTitle")}
        description={t("admin:users.deleteDescription")}
        confirmToken={deleteTarget?.email ?? ""}
        typePrompt={t("admin:users.typeEmailToConfirm")}
        copyAriaLabel={t("admin:users.copyEmailAriaLabel")}
        inputMode="email"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          remove.mutate({ userId: deleteTarget.id });
        }}
      />
    </PageShell>
  );
}

function UserActions({
  user,
  isSelf,
  isAdmin,
  isArchived,
  onSetRole,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  user: UserRow;
  isSelf: boolean;
  isAdmin: boolean;
  isArchived: boolean;
  onSetRole: (role: "user" | "admin") => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("admin");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px] self-end sm:self-auto"
            aria-label={t("users.actionsAriaLabel", { name: user.name || user.email })}
          />
        }
      >
        <MoreVertical aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {isAdmin ? (
          <DropdownMenuItem disabled={isSelf} onClick={() => onSetRole("user")}>
            <Shield className="size-4" />
            {t("users.demoteToUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => onSetRole("admin")}>
            <Shield className="size-4" />
            {t("users.promoteToAdmin")}
          </DropdownMenuItem>
        )}
        {isArchived ? (
          <DropdownMenuItem onClick={onUnarchive}>
            <ArchiveRestore className="size-4" />
            {t("users.restoreUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={isSelf} onClick={onArchive}>
            <Archive className="size-4" />
            {t("users.archiveUser")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={isSelf} onClick={onDelete}>
          <Trash className="size-4" />
          {t("users.deleteAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RolePill({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation("admin");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase",
        isAdmin
          ? "bg-violet-500/10 text-violet-700 dark:text-violet-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {isAdmin ? t("users.adminBadge") : t("users.userBadge")}
    </span>
  );
}

function ArchivedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400">
      {t("users.archivedBadge")}
    </span>
  );
}

function UnverifiedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
      {t("users.unverifiedBadge")}
    </span>
  );
}

function InviteUserDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onInvited: (reveal: InviteReveal) => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const invite = useMutation(orpc.users.invite.mutationOptions());

  const form = useForm({
    defaultValues: { email: "", name: "", role: "user" as "user" | "admin" },
    validators: { onChange: buildInviteSchema() },
    onSubmit: async ({ value }) => {
      const result = await invite.mutateAsync(value);
      onInvited({
        email: value.email,
        emailSent: result.emailSent,
        setPasswordUrl: "setPasswordUrl" in result ? result.setPasswordUrl : undefined,
      });
      form.reset();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!invite.isPending) {
          if (!next) form.reset();
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin:users.inviteTitle")}</DialogTitle>
          <DialogDescription>{t("admin:users.inviteDescription")}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-3"
        >
          <form.Field name="name">
            {(field) => (
              <TextField
                field={field}
                label={t("admin:users.nameLabel")}
                inputMode="text"
                autoComplete="name"
                className="space-y-1.5"
              />
            )}
          </form.Field>

          <form.Field name="email">
            {(field) => (
              <TextField
                field={field}
                label={t("admin:users.emailLabel")}
                type="email"
                autoComplete="email"
                placeholder={t("admin:users.emailPlaceholder")}
                className="space-y-1.5"
              />
            )}
          </form.Field>

          <form.Field name="role">
            {(field) => (
              <SelectField field={field} label={t("admin:users.roleLabel")} className="space-y-1.5">
                <SelectItem value="user">{t("admin:users.roleUser")}</SelectItem>
                <SelectItem value="admin">{t("admin:users.roleAdmin")}</SelectItem>
              </SelectField>
            )}
          </form.Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => onOpenChange(false)}
              disabled={invite.isPending}
            >
              {t("common:actions.cancel")}
            </Button>
            <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  className="min-h-[44px]"
                  disabled={!canSubmit || isSubmitting || invite.isPending}
                >
                  {isSubmitting || invite.isPending
                    ? t("admin:users.inviting")
                    : t("admin:users.sendInvite")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevealInviteDialog({
  reveal,
  onClose,
}: {
  reveal: InviteReveal | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["admin", "common", "errors"]);
  return (
    <Dialog
      open={!!reveal}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin:users.revealTitle")}</DialogTitle>
          <DialogDescription>
            {reveal?.emailSent
              ? t("admin:users.revealEmailedDescription", { email: reveal.email })
              : t("admin:users.revealNotEmailedDescription", { email: reveal?.email ?? "" })}
          </DialogDescription>
        </DialogHeader>

        {reveal?.setPasswordUrl && (
          <div className="min-w-0 space-y-1.5">
            <Label>{t("admin:users.setPasswordLinkLabel")}</Label>
            <CopyField
              value={reveal.setPasswordUrl}
              copyLabel={t("admin:users.copySetPasswordLinkAriaLabel")}
              onCopied={() => toast.success(t("admin:users.setPasswordLinkCopied"))}
              onCopyError={() => toast.error(t("errors:couldNotCopy"))}
            />
            <p className="text-xs text-muted-foreground">{t("admin:users.setPasswordLinkHint")}</p>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose} className="min-h-[44px]">
            {t("common:actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
