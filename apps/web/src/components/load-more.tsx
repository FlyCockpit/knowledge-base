import { Button } from "@knowledge-base/ui/components/button";
import { useTranslation } from "react-i18next";

type LoadMoreProps = {
  onLoadMore: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  label?: string;
  pendingLabel?: string;
};

export function LoadMore({
  onLoadMore,
  hasNextPage,
  isFetchingNextPage,
  label,
  pendingLabel,
}: LoadMoreProps) {
  const { t } = useTranslation("common");
  if (!hasNextPage) return null;

  return (
    <div className="flex justify-center py-4">
      <Button
        type="button"
        variant="outline"
        className="min-h-[44px]"
        disabled={isFetchingNextPage}
        onClick={onLoadMore}
      >
        {isFetchingNextPage
          ? (pendingLabel ?? t("actions.loadingMore"))
          : (label ?? t("actions.loadMore"))}
      </Button>
    </div>
  );
}
