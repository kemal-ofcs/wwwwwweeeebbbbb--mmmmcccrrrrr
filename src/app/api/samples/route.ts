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
import { createSampleRequest, updateSampleRequest } from "@/lib/server/samples";

export const runtime = "nodejs";

interface SampleMutationBody {
  request?: unknown;
}

function draftOf(body: SampleMutationBody) {
  return (body.request ?? {}) as Record<string, unknown>;
}

/** Cerminan `desktop_create_sample_request`. */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "samples.manage");
    const body = await readJsonBody<SampleMutationBody>(request);
    const saved = await createSampleRequest(
      getServerDatabase(),
      draftOf(body),
      operator,
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/** Cerminan `desktop_update_sample_request`. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const operator = await requireWebPermission(request, "samples.manage");
    const body = await readJsonBody<SampleMutationBody>(request);
    const saved = await updateSampleRequest(
      getServerDatabase(),
      draftOf(body),
      operator,
    );
    return noStoreJson({ sukses: true, ...saved });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
