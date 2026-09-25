import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { saveClientCodeSettings } from "@/lib/server/clients";
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

export const runtime = "nodejs";

interface ClientCodeSettingsBody {
  settings?: unknown;
}

/** Cerminan `desktop_save_client_code_settings`. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.manage");
    const body = await readJsonBody<ClientCodeSettingsBody>(request);
    const settings = await saveClientCodeSettings(
      getServerDatabase(),
      (body.settings ?? {}) as Record<string, unknown>,
    );
    return noStoreJson({ sukses: true, settings });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
