import type { NextRequest } from "next/server";
import { requireWebPermission } from "@/lib/server/auth/authorize";
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
import { assertSameOriginMutation } from "@/lib/server/http/request-security";
import {
  retryFailedNotifications,
  saveTelegramConfig,
  sendTestTelegram,
} from "@/lib/server/notifications";
import {
  NOTIFICATION_DIVISIONS,
  type NotificationDivision,
} from "@/lib/validations/notification";

export const runtime = "nodejs";

/** Cerminan `desktop_save_telegram_config`. Token kosong = pertahankan yang lama. */
export async function PUT(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    const actor = await requireWebPermission(request, "settings.manage");
    const body = await readJsonBody<{ draft?: Record<string, unknown> }>(
      request,
    );
    const draft = body.draft ?? {};
    if (
      typeof draft.bot_token !== "string" ||
      typeof draft.is_active !== "boolean"
    ) {
      throw new ApiRequestError("The Telegram settings are incomplete.", 400);
    }
    return noStoreJson({
      sukses: true,
      ...(await saveTelegramConfig(
        getServerDatabase(),
        { bot_token: draft.bot_token, is_active: draft.is_active },
        actor.kode_operator,
      )),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

/**
 * `{ action: "test", division }` = cerminan `desktop_send_test_telegram`;
 * `{ action: "retry" }` = cerminan `desktop_retry_failed_notifications`.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    await ensureServerDatabaseInitialized();
    await requireWebPermission(request, "settings.manage");
    const body = await readJsonBody<{ action?: unknown; division?: unknown }>(
      request,
    );
    const database = getServerDatabase();
    if (body.action === "retry") {
      return noStoreJson({
        sukses: true,
        ...(await retryFailedNotifications(database)),
      });
    }
    if (
      body.action === "test" &&
      typeof body.division === "string" &&
      (NOTIFICATION_DIVISIONS as readonly string[]).includes(body.division)
    ) {
      return noStoreJson({
        sukses: true,
        test: await sendTestTelegram(
          database,
          body.division as NotificationDivision,
        ),
      });
    }
    throw new ApiRequestError("Unknown Telegram action.", 400);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
