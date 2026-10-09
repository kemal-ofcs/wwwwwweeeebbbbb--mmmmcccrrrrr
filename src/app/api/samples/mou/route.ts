import type { NextRequest } from "next/server";
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
import { createMou } from "@/lib/server/mou";

export const runtime = "nodejs";

/** Cerminan `desktop_create_mou` (v2.5a, PRD F-20). */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "mou.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    // Harga satuan dan persen DP dari form hanya untuk `finance.manage`.
    const saved = await createMou(
      getServerDatabase(),
      body,
      operator,
      hasPermission(operator, "finance.manage"),
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
