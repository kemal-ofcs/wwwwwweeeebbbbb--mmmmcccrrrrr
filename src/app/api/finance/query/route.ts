import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import { getFinanceOverview } from "@/lib/server/finance";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/** Cerminan `desktop_get_finance_overview` (PRD F-17, v2.3a). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "invoices.view");
    return noStoreJson({
      sukses: true,
      ...(await getFinanceOverview(getServerDatabase())),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
