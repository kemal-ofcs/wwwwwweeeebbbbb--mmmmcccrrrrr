import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { getDashboard } from "@/lib/server/dashboard";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";

export const runtime = "nodejs";

/** Cerminan `desktop_get_dashboard` (F-40a, D-52). */
export async function POST(request: NextRequest) {
  try {
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "dashboard.view");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const result = await getDashboard(getServerDatabase(), body, operator);
    return noStoreJson({ sukses: true, ...result });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
