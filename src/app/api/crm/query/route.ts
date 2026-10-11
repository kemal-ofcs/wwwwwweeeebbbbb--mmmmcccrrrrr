import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { listCrm } from "@/lib/server/crm";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";

export const runtime = "nodejs";

/** Cerminan `desktop_list_crm` (v3.6a, PRD F-29). */
export async function POST(request: NextRequest) {
  try {
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "clients.view");
    return noStoreJson({
      sukses: true,
      ...(await listCrm(getServerDatabase())),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
