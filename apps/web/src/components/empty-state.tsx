import { cn } from "@knowledge-base/ui/lib/utils";
import type { ReactNode } from "react";

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 py-12 text-center", className)}>
      <p className="text-sm font-medium">{title}</p>
      {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      {action}
    </div>
  );
}
