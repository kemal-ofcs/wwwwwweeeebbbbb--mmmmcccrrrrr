import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { saveCompanyProfile } from "@/lib/server/company/company-profile";
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

interface CompanyMutationBody {
  profile?: unknown;
}

/**
 * Simpan identitas perusahaan.
 *
 * `PUT`, bukan `POST`, hanya karena ini murni penggantian satu baris yang sudah
 * ada. Yang tidak boleh adalah `GET` — build Desktop/Mobile memakai
 * `output: "export"` yang tidak dapat melayani route handler GET dinamis, jadi
 * pembacaannya ada di `company/query`.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.manage");
    const body = await readJsonBody<CompanyMutationBody>(request);
    const profile = await saveCompanyProfile(
      getServerDatabase(),
      (body.profile ?? {}) as Record<string, unknown>,
    );
    return noStoreJson({ sukses: true, profile });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
