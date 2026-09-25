import type { NextRequest } from "next/server";
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
import { getMediaData } from "@/lib/server/media";

export const runtime = "nodejs";

/** Cerminan `desktop_get_media`: isi satu foto. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "samples.view");
    const body = await readJsonBody<{ id?: unknown }>(request);
    return noStoreJson({
      sukses: true,
      ...(await getMediaData(getServerDatabase(), body.id)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
