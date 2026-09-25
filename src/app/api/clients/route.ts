import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
import { registerClient, updateClient } from "@/lib/server/clients";
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

interface ClientMutationBody {
  client?: unknown;
}

function draftOf(body: ClientMutationBody) {
  return (body.client ?? {}) as Record<string, unknown>;
}

/** Cerminan `desktop_register_client`: lead baru dengan tag kode Web. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "clients.manage");
    const body = await readJsonBody<ClientMutationBody>(request);
    const saved = await registerClient(
      getServerDatabase(),
      draftOf(body),
      operator.id,
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/** Cerminan `desktop_update_client`. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "clients.manage");
    const body = await readJsonBody<ClientMutationBody>(request);
    const saved = await updateClient(getServerDatabase(), draftOf(body));
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
