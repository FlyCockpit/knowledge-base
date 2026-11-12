import { z } from "zod";
import { originUrl } from "../url.js";

// ---------------------------------------------------------------------------
// Build-time client variable DECLARATIONS. See ./shared.ts for why these live
// in a side-effect-free module of their own.
//
// PUBLIC: every one of these is inlined into the browser bundle. Never a secret.
// ---------------------------------------------------------------------------

export const webVars = {
  VITE_APP_NAME: z.string().min(1).max(80).optional(),
  VITE_SERVER_URL: originUrl("VITE_SERVER_URL").optional(),
  VITE_DEV_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  VITE_DEV_SERVER_URL: originUrl("VITE_DEV_SERVER_URL").optional(),
};
