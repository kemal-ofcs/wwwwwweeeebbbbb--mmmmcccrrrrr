import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import { saveFinanceOption } from "@/lib/server/finance";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/** Cerminan `desktop_save_finance_option` (PRD F-17, v2.3a). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(
      request,
      "finance_options.manage",
    );
    const body = await readJsonBody<Record<string, unknown>>(request);
    return noStoreJson({
      sukses: true,
      ...(await saveFinanceOption(
        getServerDatabase(),
        (body.option ?? {}) as Record<string, unknown>,
        operator,
      )),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
