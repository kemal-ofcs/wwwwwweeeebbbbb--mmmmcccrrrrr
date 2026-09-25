import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { saveMasterOption } from "@/lib/server/clients";
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

interface MasterOptionBody {
  option?: unknown;
}

/** Cerminan `desktop_save_master_option`: tambah atau ubah satu pilihan. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "master_data.manage");
    const body = await readJsonBody<MasterOptionBody>(request);
    const option = await saveMasterOption(
      getServerDatabase(),
      (body.option ?? {}) as Record<string, unknown>,
      operator,
    );
    return noStoreJson({ sukses: true, option });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
