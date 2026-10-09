import type { NextRequest } from "next/server";
import { hasPermission } from "@/lib/auth/access";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { requireWebSession } from "@/lib/server/auth/authorize";
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
import { updateMou } from "@/lib/server/mou";

export const runtime = "nodejs";

/**
 * Cerminan `desktop_update_mou`: `mou.manage` mengubah isi draf,
 * `finance.manage` harga satuan dan persen DP; tanpa keduanya ditolak.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebSession(request);
    const canEdit = hasPermission(operator, "mou.manage");
    const canPrice = hasPermission(operator, "finance.manage");
    if (!canEdit && !canPrice) {
      throw new AuthorizationError("Access denied for this action.", 403);
    }
    const body = await readJsonBody<Record<string, unknown>>(request);
    const saved = await updateMou(
      getServerDatabase(),
      body,
      operator,
      canEdit,
      canPrice,
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
