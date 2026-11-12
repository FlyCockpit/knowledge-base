// Test-only process boundary, bundled exactly like the service output entry.
import { superviseService } from "@knowledge-base/env/service-output";

superviseService("worker", new URL("./child.mjs", import.meta.url));
