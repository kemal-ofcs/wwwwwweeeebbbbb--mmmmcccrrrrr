import "server-only";

import type { Client } from "@libsql/client";
import { hasPermission } from "@/lib/auth/access";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { AuthorizationError } from "@/lib/auth/permission-assertion";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  COLD_DIGEST_HOUR,
  COLD_DIGEST_INSERT_SQL,
  COLD_DIGEST_LEADS_SQL,
  COLD_DIGEST_STATE_SQL,
  coldDigestWindow,
  companyClock,
  isTelegramBotToken,
  NOTIFICATION_BELL_LIST_SQL,
  NOTIFICATION_CLAIM_SQL,
  NOTIFICATION_CONTEXT_SQL,
  NOTIFICATION_DIVISIONS,
  NOTIFICATION_DUE_SQL,
  NOTIFICATION_FAILED_LIST_SQL,
  NOTIFICATION_FAILED_SQL,
  NOTIFICATION_MARK_SEEN_SQL,
  NOTIFICATION_PENDING_COUNT_SQL,
  NOTIFICATION_PERMISSIONS,
  NOTIFICATION_RETRY_FAILED_SQL,
  NOTIFICATION_SENT_SQL,
  NOTIFICATION_SETTINGS_SQL,
  NOTIFICATION_SKIP_SQL,
  NOTIFICATION_UNREAD_COUNT_SQL,
  type NotificationDivision,
  renderNotification,
  retryDelayMinutes,
  TELEGRAM_CONFIG_SAVE_SQL,
  TELEGRAM_TOKEN_INVALID,
  TELEGRAM_TOKEN_REQUIRED,
  testMessage,
} from "@/lib/validations/notification";
import {
  type BusinessSettings,
  readBusinessSettings,
} from "@/lib/validations/sample";

/**
 * Notifikasi divisi (PRD FR-08) — jalur Web. Cermin `notifications.rs`: SQL
 * dan aturannya ada di `validations/notification.ts`, berkas ini hanya I/O.
 */

interface Context {
  nowEpoch: number;
  timezone: string;
  isActive: boolean;
  botToken: string;
  updatedAt: string;
  updatedBy: string;
  settings: BusinessSettings;
}

async function loadContext(client: Client): Promise<Context> {
  const [context, settings] = await client.batch(
    [NOTIFICATION_CONTEXT_SQL, NOTIFICATION_SETTINGS_SQL],
    "read",
  );
  const row = context?.rows[0] ?? {};
  const text = (key: string) => {
    const value = (row as Record<string, unknown>)[key];
    return value == null ? "" : String(value);
  };
  return {
    nowEpoch: Number(text("now_epoch")),
    timezone: text("timezone").trim() || "Asia/Jakarta",
    isActive: Number(text("is_active")) === 1,
    botToken: text("bot_token").trim(),
    updatedAt: text("updated_at"),
    updatedBy: text("updated_by"),
    settings: readBusinessSettings(
      Object.fromEntries(
        (settings?.rows ?? []).map((setting) => [
          String(setting.key),
          String(setting.value ?? ""),
        ]),
      ),
    ),
  };
}

function chatId(settings: BusinessSettings, division: string) {
  switch (division) {
    case "CS":
      return settings.telegram_chat_id_cs;
    case "RND":
      return settings.telegram_chat_id_rnd;
    case "FINANCE":
      return settings.telegram_chat_id_finance;
    case "DESIGN":
      return settings.telegram_chat_id_design;
    case "PRODUCTION":
      return settings.telegram_chat_id_production;
    default:
      return "";
  }
}

/**
 * Kirim satu pesan teks polos. Gagal = penjelasan Telegram apa adanya (E-09),
 * hanya ditampilkan untuk pemegang `settings.manage`.
 */
async function sendTelegram(
  token: string,
  chat: string,
  text: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.ok) return { ok: true };
    const body = await response.text().catch(() => "");
    let description = body;
    try {
      const parsed = JSON.parse(body) as { description?: unknown };
      if (typeof parsed.description === "string") {
        description = parsed.description;
      }
    } catch {
      // Bukan JSON: pakai teks mentahnya.
    }
    return {
      ok: false,
      detail: `HTTP ${response.status}: ${description.slice(0, 300)}`,
    };
  } catch (error) {
    // Pesan fetch tidak memuat URL, jadi token tidak bocor ke `last_error`.
    return {
      ok: false,
      detail: `Request to Telegram failed: ${
        error instanceof Error ? error.message : "unknown cause"
      }`,
    };
  }
}

async function ensureColdDigest(
  client: Client,
  context: Context,
  ready: boolean,
) {
  const { date, hour } = companyClock(context.nowEpoch, context.timezone);
  if (hour < COLD_DIGEST_HOUR) return;
  const id = `cold-digest:${date}`;
  const state = await client.execute({
    sql: COLD_DIGEST_STATE_SQL,
    args: [id],
  });
  if (Number(state.rows[0]?.done ?? 0) > 0) return;
  const lastId = String(state.rows[0]?.last_id ?? "");
  const window = coldDigestWindow(
    date,
    lastId.startsWith("cold-digest:") ? lastId.slice(12) : null,
    context.settings.lead_warm_max_days,
    context.timezone,
  );
  if (!window) return;
  const leads = (
    await client.execute({ sql: COLD_DIGEST_LEADS_SQL, args: window })
  ).rows.map((lead) => ({
    client_code: String(lead.client_code ?? ""),
    client_name: String(lead.client_name ?? ""),
    pic: String(lead.pic ?? ""),
  }));
  const status =
    ready && leads.length > 0 && context.settings.telegram_chat_id_cs !== ""
      ? "PENDING"
      : "SKIPPED";
  await client.execute({
    sql: COLD_DIGEST_INSERT_SQL,
    args: [id, JSON.stringify({ date, leads }), status],
  });
}

/**
 * Satu putaran pengirim: ringkasan Cold hari ini bila waktunya, lalu klaim dan
 * kirim baris yang jatuh tempo. Web tidak punya worker latar (D-04), jadi ini
 * dipanggil lewat `after()` dari route yang sering dipakai.
 */
export async function dispatchNotifications(client: Client) {
  const context = await loadContext(client);
  const ready = context.isActive && context.botToken !== "";
  await ensureColdDigest(client, context, ready);
  if (!ready) return;
  const due = await client.execute(NOTIFICATION_DUE_SQL);
  for (const row of due.rows) {
    const id = String(row.id);
    const claimed = await client.execute({
      sql: NOTIFICATION_CLAIM_SQL,
      args: [id],
    });
    if (claimed.rowsAffected !== 1) continue;
    const chat = chatId(context.settings, String(row.target_division));
    if (!chat) {
      await client.execute({ sql: NOTIFICATION_SKIP_SQL, args: [id] });
      continue;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(row.payload_json ?? "{}"));
    } catch {
      // Payload rusak tetap dikirim sebagai teks jenis kejadiannya.
    }
    const result = await sendTelegram(
      context.botToken,
      chat,
      renderNotification(
        String(row.event_type),
        payload,
        String(row.occurred_at ?? ""),
        context.timezone,
      ),
    );
    await client.execute(
      result.ok
        ? { sql: NOTIFICATION_SENT_SQL, args: [id] }
        : {
            sql: NOTIFICATION_FAILED_SQL,
            args: [
              id,
              result.detail,
              retryDelayMinutes(Number(row.attempts ?? 0) + 1),
            ],
          },
    );
  }
}

/** `after()` menelan error supaya respons utama tidak pernah ikut gagal. */
export async function dispatchNotificationsQuietly(client: Client) {
  try {
    await dispatchNotifications(client);
  } catch {
    // Dicoba lagi pada request atau siklus sync berikutnya.
  }
}

/** Pengaturan › Notifikasi: tanpa token, ditambah antrean dan daftar gagal. */
export async function getTelegramSettings(client: Client) {
  const context = await loadContext(client);
  const [pending, failed] = await client.batch(
    [NOTIFICATION_PENDING_COUNT_SQL, NOTIFICATION_FAILED_LIST_SQL],
    "read",
  );
  return {
    config: {
      is_active: context.isActive,
      has_bot_token: context.botToken !== "",
      updated_at: context.updatedAt,
      updated_by: context.updatedBy,
    },
    pending: Number(pending?.rows[0]?.total ?? 0),
    failed: (failed?.rows ?? []).map((row) => ({
      id: String(row.id),
      event_type: String(row.event_type),
      target_division: String(row.target_division),
      occurred_at: String(row.occurred_at ?? ""),
      attempts: Number(row.attempts ?? 0),
      last_error: String(row.last_error ?? ""),
    })),
  };
}

export async function saveTelegramConfig(
  client: Client,
  draft: { bot_token: string; is_active: boolean },
  actor: string,
) {
  const token = draft.bot_token.trim();
  if (token && !isTelegramBotToken(token)) {
    throw new ApiRequestError(TELEGRAM_TOKEN_INVALID, 400);
  }
  const context = await loadContext(client);
  if (draft.is_active && !token && !context.botToken) {
    throw new ApiRequestError(TELEGRAM_TOKEN_REQUIRED, 400);
  }
  await client.execute({
    sql: TELEGRAM_CONFIG_SAVE_SQL,
    args: [token, draft.is_active ? 1 : 0, actor],
  });
  return getTelegramSettings(client);
}

export async function sendTestTelegram(
  client: Client,
  division: NotificationDivision,
) {
  if (!NOTIFICATION_DIVISIONS.includes(division)) {
    throw new ApiRequestError("Choose a division.", 400);
  }
  const context = await loadContext(client);
  if (!context.botToken) {
    throw new ApiRequestError(TELEGRAM_TOKEN_REQUIRED, 400);
  }
  const chat = chatId(context.settings, division);
  if (!chat) {
    throw new ApiRequestError(
      `Set the ${division} group chat ID in Business settings first.`,
      400,
    );
  }
  const result = await sendTelegram(
    context.botToken,
    chat,
    testMessage(division),
  );
  return result.ok
    ? { delivered: true, detail: "" }
    : { delivered: false, detail: result.detail };
}

export async function retryFailedNotifications(client: Client) {
  await client.execute(NOTIFICATION_RETRY_FAILED_SQL);
  await dispatchNotificationsQuietly(client);
  return getTelegramSettings(client);
}

/**
 * Divisi lonceng yang boleh dilihat (urutan CS, RnD, Finance, Desain). Tanpa satu pun
 * izin `notifications_*.view` = ditolak. Cermin `notification_access`.
 */
export function notificationAccess(actor: OperatorUser) {
  const allowed = NOTIFICATION_DIVISIONS.map((division) =>
    hasPermission(actor, NOTIFICATION_PERMISSIONS[division]),
  ) as [boolean, boolean, boolean, boolean, boolean];
  if (!allowed.some(Boolean)) {
    throw new AuthorizationError("Access denied for this action.", 403);
  }
  return allowed;
}

/**
 * Lonceng: 30 kejadian terakhir dari divisi yang boleh dilihat, plus jumlah
 * yang belum dibaca. `allowed` = urutan CS, RnD, Finance, Desain.
 */
export async function listNotifications(
  client: Client,
  allowed: readonly [boolean, boolean, boolean, boolean, boolean],
  operatorId: number,
) {
  const context = await loadContext(client);
  const flags = allowed.map((flag) => (flag ? 1 : 0));
  const [unread, items] = await client.batch(
    [
      { sql: NOTIFICATION_UNREAD_COUNT_SQL, args: [...flags, operatorId] },
      { sql: NOTIFICATION_BELL_LIST_SQL, args: flags },
    ],
    "read",
  );
  return {
    unread: Number(unread?.rows[0]?.total ?? 0),
    items: (items?.rows ?? []).map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload_json ?? "{}"));
      } catch {
        // Tampilkan jenis kejadiannya saja.
      }
      const eventType = String(row.event_type);
      return {
        id: String(row.id),
        event_type: eventType,
        target_division: String(row.target_division),
        text: renderNotification(
          eventType,
          payload,
          String(row.occurred_at ?? ""),
          context.timezone,
        ),
        client_id:
          typeof payload.client_id === "string" ? payload.client_id : "",
        sample_id:
          typeof payload.sample_id === "string" ? payload.sample_id : "",
        created_at: String(row.created_at ?? ""),
      };
    }),
  };
}

export async function markNotificationsSeen(
  client: Client,
  operatorId: number,
) {
  await client.execute({ sql: NOTIFICATION_MARK_SEEN_SQL, args: [operatorId] });
}
