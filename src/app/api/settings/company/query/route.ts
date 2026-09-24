import type { NextRequest } from "next/server";
import { requireWebSession } from "@/lib/server/auth/authorize";
import { readCompanyProfile } from "@/lib/server/company/company-profile";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  noStoreJson,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { isSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/**
 * Baca identitas perusahaan.
 *
 * SENGAJA hanya menuntut sesi, bukan `settings.view`. Nilai-nilai ini muncul di
 * kop setiap dokumen yang dicetak aplikasi; menguncinya di balik izin
 * pengaturan akan membuat operator biasa mencetak dokumen tanpa kop. Isinya pun
 * bukan rahasia — ini kepala surat perusahaan itu sendiri. Aturan yang sama
 * dieja di `desktop_get_company_profile`.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginMutation(request)) {
      return noStoreJson({ sukses: false, pesan: "Origin not allowed." }, 403);
    }
    await ensureServerDatabaseInitialized();
    await requireWebSession(request);
    return noStoreJson({
      sukses: true,
      profile: await readCompanyProfile(getServerDatabase()),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
