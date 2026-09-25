import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import { listOperatorDirectory } from "@/lib/server/leads";

export const runtime = "nodejs";

/** Cerminan `desktop_list_operator_directory`: operator aktif untuk pilihan PIC. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "leads.view");
    return noStoreJson({
      sukses: true,
      operators: await listOperatorDirectory(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
