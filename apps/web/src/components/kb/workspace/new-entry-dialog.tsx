import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm, useStore } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";

import { documentName, type FilePathIssue, joinPath, pathIssue } from "@/lib/kb-workspace/file-ops";

export type NewEntryKind = "file" | "folder";
export type NewEntryValues = { folderName: string; fileName: string };

/**
 * Pure: the document path a New file / New folder entry creates, or null
 * while a required name is still empty. Git keeps no empty folders, so a new
 * folder is its first document's folder.
 */
export function newEntryPath(
  kind: NewEntryKind,
  folder: string,
  values: NewEntryValues,
): string | null {
  const file = documentName(values.fileName);
  if (file === "") return null;
  if (kind === "file") return joinPath(folder, file);
  const name = values.folderName.trim().replace(/\/+$/, "");
  if (name === "") return null;
  return joinPath(folder, `${name}/${file}`);
}

/** Pure: the issue the entry's path has (null: fine, or nothing to check yet). */
export function newEntryIssue(
  kind: NewEntryKind,
  folder: string,
  values: NewEntryValues,
  existing: ReadonlySet<string>,
): FilePathIssue | null {
  const path = newEntryPath(kind, folder, values);
  return path === null ? null : pathIssue(path, existing);
}

/**
 * Create → Dialog: a new document in `folder`, or a new folder there with its
 * first document. `onCreate` gets the full path; the shell opens a New
 * document draft at it (nothing is written until the draft is saved).
 */
export function NewEntryDialog({
  kind,
  folder,
  open,
  onOpenChange,
  existing,
  onCreate,
}: {
  kind: NewEntryKind;
  /** The folder it goes in ("" = the top level, else "a/b/"). */
  folder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: ReadonlySet<string>;
  onCreate: (path: string) => void;
}) {
  const { t } = useTranslation("kb");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(
              kind === "file"
                ? "workspace.fileOps.newEntry.fileTitle"
                : "workspace.fileOps.newEntry.folderTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              kind === "file"
                ? "workspace.fileOps.newEntry.fileDescription"
                : "workspace.fileOps.newEntry.folderDescription",
              { folder: folder || t("workspace.fileOps.root") },
            )}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <NewEntryForm
            kind={kind}
            folder={folder}
            existing={existing}
            onCancel={() => onOpenChange(false)}
            onCreate={(path) => {
              onOpenChange(false);
              onCreate(path);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's form (exported for tests): the name field(s), live checked, and the resulting path. */
export function NewEntryForm({
  kind,
  folder,
  existing,
  onCancel,
  onCreate,
}: {
  kind: NewEntryKind;
  folder: string;
  existing: ReadonlySet<string>;
  onCancel: () => void;
  onCreate: (path: string) => void;
}) {
  const { t } = useTranslation("kb");
  const message = (issue: FilePathIssue | null) =>
    issue ? t(`workspace.fileOps.pathIssue.${issue}`) : undefined;
  const form = useForm({
    defaultValues: { folderName: "", fileName: "" } as NewEntryValues,
    onSubmit: ({ value }) => {
      const path = newEntryPath(kind, folder, value);
      if (path && !newEntryIssue(kind, folder, value, existing)) onCreate(path);
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const path = newEntryPath(kind, folder, values);
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {kind === "folder" && (
        <form.Field
          name="folderName"
          validators={{
            onChange: ({ value }) =>
              value.trim() === ""
                ? t("workspace.fileOps.pathIssue.empty")
                : message(
                    newEntryIssue(
                      kind,
                      folder,
                      { folderName: value, fileName: form.getFieldValue("fileName") || "x" },
                      existing,
                    ),
                  ),
          }}
        >
          {(field) => (
            <TextField
              field={field}
              label={t("workspace.fileOps.newEntry.folderName")}
              autoComplete="off"
              inputMode="text"
              autoFocus
            />
          )}
        </form.Field>
      )}
      <form.Field
        name="fileName"
        validators={{
          onChange: ({ value }) =>
            message(
              newEntryIssue(
                kind,
                folder,
                { folderName: form.getFieldValue("folderName") || "x", fileName: value },
                existing,
              ),
            ),
        }}
      >
        {(field) => (
          <TextField
            field={field}
            label={t(
              kind === "file"
                ? "workspace.fileOps.newEntry.fileName"
                : "workspace.fileOps.newEntry.firstFileName",
            )}
            description={t("workspace.fileOps.newEntry.fileNameHint")}
            autoComplete="off"
            inputMode="text"
            autoFocus={kind === "file"}
          />
        )}
      </form.Field>
      <p className="min-h-5 break-all text-sm text-muted-foreground" aria-live="polite">
        {path ? t("workspace.fileOps.newEntry.resultingPath", { path }) : null}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          {t("workspace.fileOps.newEntry.cancel")}
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          disabled={path === null || newEntryIssue(kind, folder, values, existing) !== null}
        >
          {t("workspace.fileOps.newEntry.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
