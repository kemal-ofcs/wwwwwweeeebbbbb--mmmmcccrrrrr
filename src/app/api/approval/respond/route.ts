import { after, type NextRequest } from "next/server";
import {
  checkLoginRateLimit,
  recordLoginFailure,
} from "@/lib/auth/login-rate-limit";
import { recordInvalidApproval, respondApproval } from "@/lib/server/approval";
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
import { dispatchNotificationsQuietly } from "@/lib/server/notifications";
import { APPROVAL_INVALID } from "@/lib/validations/approval";

export const runtime = "nodejs";

/** Jawaban klien dari halaman tautan persetujuan (v2.5b, PRD F-18). Tanpa login. */
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
    try {
      const answered = await respondApproval(database, token, body);
      // Grup CS diberi tahu sesudah respons (keputusan P).
      after(() => dispatchNotificationsQuietly(database));
      return noStoreJson({ sukses: true, ...answered });
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.message === APPROVAL_INVALID
      ) {
        await recordLoginFailure(database, address, "approval");
        await recordInvalidApproval(database, token);
      }
      throw error;
    }
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
