import type { NextRequest } from "next/server";
import {
  checkLoginRateLimit,
  recordLoginFailure,
} from "@/lib/auth/login-rate-limit";
import { readApproval, recordInvalidApproval } from "@/lib/server/approval";
import {
  ensureServerDatabaseInitialized,
  getServerDatabase,
} from "@/lib/server/db";
import {
  ApiRequestError,
  noStoreJson,
  readJsonBody,
  toApiErrorResponse,
} from "@/lib/server/http/api-response";
import {
  assertSameOriginMutation,
  getClientAddress,
} from "@/lib/server/http/request-security";

export const runtime = "nodejs";

/**
 * Halaman klien membaca tautan persetujuan (v2.5b, PRD F-18). Tanpa login;
 * tautan yang tidak sah dihitung rate limit dan dicatat di audit (E-24).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const database = getServerDatabase();
    const address = getClientAddress(request);
    const limit = await checkLoginRateLimit(database, address, "approval");
    if (!limit.allowed) {
      throw new ApiRequestError(
        `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`,
        429,
      );
    }
    const body = await readJsonBody<Record<string, unknown>>(request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const approval = await readApproval(database, token);
    if (!approval.valid) {
      await recordLoginFailure(database, address, "approval");
      await recordInvalidApproval(database, token);
    }
    return noStoreJson({ sukses: true, approval });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
