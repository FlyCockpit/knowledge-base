import { CheckCircle2, ImageIcon, XCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFileDropTarget } from "@/hooks/use-file-drop-target";
import { DOCUMENT_STAGED_ASSETS_MAX } from "@/hooks/use-kb-editor";
import { type DroppedFile, planUpload, type UploadPlan } from "@/lib/kb-workspace/file-ops";

/**
 * OS files dropped on the tree, through the app's one drop dispatcher
 * (`FileDropGuard` + `useFileDropTarget`; never a React `onDrop` for files).
 * The registry hands over only the files, so the folder comes from the last
 * row the drag was over (`hover`): a folder row is that folder, a file row
 * its folder, empty space the top level.
 */
export function useTreeFileDrop(onFiles: ((files: File[], folder: string) => void) | undefined) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const folder = useRef<string>("");
  const hover = useCallback((next: string | null) => {
    folder.current = next ?? "";
    setDropFolder(next);
  }, []);
  const onDrop = useCallback(
    (files: File[]) => {
      const target = folder.current;
      hover(null);
      onFiles?.(files, target);
    },
    [onFiles, hover],
  );
  useFileDropTarget(onFiles ? element : null, onDrop);
  return { setElement, dropFolder, hover };
}

/** Pure: a drop's plan, from the browser's File objects. */
export function planDroppedFiles(
  files: readonly Pick<File, "name" | "type" | "size">[],
  folder: string,
  existing: ReadonlySet<string>,
): UploadPlan[] {
  const dropped: DroppedFile[] = files.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
  }));
  return planUpload(dropped, folder, existing);
}

/**
 * What a drop will do, file by file: the document it opens, images (staged
 * into it), and refused files with the reason. The dialog around it names the folder.
 */
export function UploadSummary({ plan }: { plan: readonly UploadPlan[] }) {
  const { t } = useTranslation("kb");
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5 text-sm" data-testid="upload-summary">
        {plan.map((item, index) => (
          <li
            // Two dropped files can share a name; the position identifies the entry.
            key={`${index}-${item.file.name}`}
            className="flex min-w-0 items-start gap-2"
            data-kind={item.kind}
          >
            {item.kind === "document" ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : item.kind === "image" ? (
              <ImageIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <span className="min-w-0 break-all">
              <span className="font-mono">{item.file.name}</span>
              {" — "}
              {item.kind === "document"
                ? t("workspace.fileOps.drop.accepted", { path: item.path })
                : item.kind === "image"
                  ? t("workspace.fileOps.drop.image")
                  : item.reason === "path"
                    ? t("workspace.fileOps.drop.refused.path", {
                        issue: t(`workspace.fileOps.pathIssue.${item.issue ?? "invalid"}`),
                      })
                    : t(`workspace.fileOps.drop.refused.${item.reason}`, {
                        max: DOCUMENT_STAGED_ASSETS_MAX,
                      })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
