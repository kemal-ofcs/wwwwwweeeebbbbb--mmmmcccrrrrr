import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import { deleteItem, saveItem } from "@/lib/server/example-domain";
import {
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import { assertSameOriginMutation } from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/** Cerminan `desktop_save_item`: membuat atau memperbarui satu item. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "items.manage");
    const body = await readJsonBody<Record<string, unknown>>(request);
    const kodeItem = await saveItem(getServerDatabase(), body ?? {});
    return noStoreJson({ sukses: true, kode_item: kodeItem });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/** Cerminan `desktop_delete_item`. */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "items.manage");
    const body = await readJsonBody<{ kode_item?: unknown }>(request);
    await deleteItem(getServerDatabase(), body?.kode_item);
    return noStoreJson({ sukses: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
