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
import { uploadSampleMedia } from "@/lib/server/media";
import { mediaPurposePermission } from "@/lib/validations/media";

export const runtime = "nodejs";

/** Cerminan `desktop_upload_sample_media`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const body = await readJsonBody<Record<string, unknown>>(request);
    // Mockup milik desainer (`design.manage`), foto lain milik CS.
    const operator = await requireWebPermission(
      request,
      mediaPurposePermission(body.purpose),
    );
    return noStoreJson({
      sukses: true,
      ...(await uploadSampleMedia(getServerDatabase(), body, operator)),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
