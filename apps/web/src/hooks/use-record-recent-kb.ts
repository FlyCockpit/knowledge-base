import { useEffect } from "react";

import { recordRecentKb } from "@/lib/recent-kbs";

/** Remembers that this viewer opened this KB (the sidebar's "recently opened"). */
export function useRecordRecentKb(userId: string | null, kbId: string): void {
  useEffect(() => {
    if (userId) recordRecentKb(userId, kbId);
  }, [userId, kbId]);
}
