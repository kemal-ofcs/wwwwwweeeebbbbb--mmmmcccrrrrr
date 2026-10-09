import { after, type NextRequest } from "next/server";
import { hasPermission } from "@/lib/auth/access";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { dispatchNotificationsQuietly } from "@/lib/server/notifications";
import { recordDesignStep } from "@/lib/server/samples";
import {
  DUMMY_LIMIT_PERMISSION,
  designActionPermission,
} from "@/lib/validations/design";

export const runtime = "nodejs";

/** Cerminan `desktop_record_design_step` (v2.4, PRD F-19). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    // Pekerjaan desainer menuntut `design.manage`, respons klien `samples.manage`.
    const operator = await requireWebPermission(
      request,
      designActionPermission(body.action),
    );
    const step = await recordDesignStep(
      getServerDatabase(),
      body,
      operator,
      hasPermission(operator, DUMMY_LIMIT_PERMISSION),
    );
    // Dummy direvisi klien diberi tahu ke grup Desain (PRD FR-08).
    after(() => dispatchNotificationsQuietly(getServerDatabase()));
    return noStoreJson({ sukses: true, ...step });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
