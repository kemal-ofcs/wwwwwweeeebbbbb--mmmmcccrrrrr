import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import {
  initDatabaseSchema,
  NOTIFICATION_PERMISSION_SEED_SQL,
} from "@/lib/db-schema";
import { companyDayBoundsUtc } from "@/lib/validations/client";
import {
  COLD_DIGEST_HOUR,
  companyClock,
  NOTIFICATION_CLAIM_SQL,
  TELEGRAM_TOKEN_INVALID,
  TELEGRAM_TOKEN_REQUIRED,
} from "@/lib/validations/notification";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const CS = { id: 7, role: "CS" };
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

const clients = await import("@/lib/server/clients");
const samples = await import("@/lib/server/samples");
const business = await import("@/lib/server/business-settings");
const notifications = await import("@/lib/server/notifications");

let client: Client;
let directory: string;
let channelId: string;
let categoryId: string;
let phone = 81_300_000_000;
const originalFetch = globalThis.fetch;
const sent: { url: string; chat_id: string; text: string }[] = [];
let reply = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

async function rows(sql: string, args: (string | number)[] = []) {
  return (await client.execute({ sql, args })).rows.map(
    (row) => ({ ...row }) as Record<string, unknown>,
  );
}

async function newLead() {
  phone += 1;
  return clients.registerClient(
    client,
    {
      name: "Aura Cosmetics",
      phone: `0${phone}`,
      channel_option_id: channelId,
      product_category_option_id: categoryId,
    },
    CS,
  );
}

async function setChats(cs: string, rnd: string, finance: string) {
  await business.saveBusinessSettings(
    client,
    {
      default_free_revision_limit: 1,
      sample_fee_mode: "PER_REQUEST",
      lead_hot_max_days: 3,
      lead_warm_max_days: 7,
      max_photos_per_sample: 10,
      telegram_chat_id_cs: cs,
      telegram_chat_id_rnd: rnd,
      telegram_chat_id_finance: finance,
      offline_login_max_days: 7,
    },
    ADMIN,
  );
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "notifications-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active'),
            (7, 'OP7', 'Rina CS', 'rina', 'x', 'Active');`,
  );
  channelId = (
    await clients.saveMasterOption(
      client,
      { kind: "LEAD_CHANNEL", code: "IG", label: "Instagram" },
      ADMIN,
    )
  ).id;
  categoryId = (
    await clients.saveMasterOption(
      client,
      { kind: "PRODUCT_CATEGORY", code: "SKIN", label: "Skincare" },
      ADMIN,
    )
  ).id;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ url: String(url), chat_id: body.chat_id, text: body.text });
    return reply();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  client.close();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows: libsql baru melepas berkas database saat proses selesai, jadi
    // penghapusan di sini gagal EBUSY. Folder temp boleh tertinggal.
  }
});

describe("notifikasi divisi, jalur Web", () => {
  test("seed izin lonceng identik dengan Rust dan diberikan ke role divisinya", async () => {
    const tursoRs = ["desktop", "mobile"]
      .map((dir) =>
        join(import.meta.dir, `../../../src-tauri/src/${dir}/turso.rs`),
      )
      .find(existsSync);
    const source = readFileSync(tursoRs as string, "utf8");
    for (const sql of NOTIFICATION_PERMISSION_SEED_SQL) {
      expect(source).toContain(`"${sql}"`);
    }
    const granted = await rows(
      `SELECT r.role_key, rp.permission_key FROM app_role r
       JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE rp.permission_key LIKE 'notifications_%' AND r.role_key IN ('cs', 'rnd', 'finance', 'operator', 'crm')
       ORDER BY r.role_key;`,
    );
    expect(granted).toEqual([
      { role_key: "cs", permission_key: "notifications_cs.view" },
      { role_key: "finance", permission_key: "notifications_finance.view" },
      { role_key: "operator", permission_key: "notifications_cs.view" },
      { role_key: "rnd", permission_key: "notifications_rnd.view" },
    ]);
  });

  test("bot mati: kejadian tetap tercatat untuk lonceng, Telegram SKIPPED", async () => {
    const { id } = await newLead();
    expect(
      await rows(
        "SELECT event_type, target_division, status FROM notification_outbox WHERE id = ?;",
        [`lead-new:${id}`],
      ),
    ).toEqual([
      { event_type: "LEAD_NEW", target_division: "CS", status: "SKIPPED" },
    ]);
    await notifications.dispatchNotifications(client);
    expect(sent).toHaveLength(0);
  });

  test("token: salah ditolak, wajib saat dinyalakan, kosong mempertahankan, tidak pernah dikembalikan", async () => {
    await expect(
      notifications.saveTelegramConfig(
        client,
        { bot_token: "nope", is_active: true },
        "SPD001",
      ),
    ).rejects.toThrow(TELEGRAM_TOKEN_INVALID);
    await expect(
      notifications.saveTelegramConfig(
        client,
        { bot_token: "", is_active: true },
        "SPD001",
      ),
    ).rejects.toThrow(TELEGRAM_TOKEN_REQUIRED);
    await notifications.saveTelegramConfig(
      client,
      { bot_token: TOKEN, is_active: true },
      "SPD001",
    );
    const saved = await notifications.saveTelegramConfig(
      client,
      { bot_token: "", is_active: true },
      "SPD001",
    );
    expect(saved.config).toMatchObject({
      is_active: true,
      has_bot_token: true,
      updated_by: "SPD001",
    });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(await rows("SELECT bot_token FROM telegram_config;")).toEqual([
      { bot_token: TOKEN },
    ]);
  });

  test("lead baru dikirim tepat sekali ke grup CS", async () => {
    await setChats("-100111", "-100222", "");
    const { id, client_code } = await newLead();
    expect(
      await rows("SELECT status FROM notification_outbox WHERE id = ?;", [
        `lead-new:${id}`,
      ]),
    ).toEqual([{ status: "PENDING" }]);
    await notifications.dispatchNotifications(client);
    await notifications.dispatchNotifications(client);
    const leadMessages = sent.filter((message) =>
      message.text.includes(client_code),
    );
    expect(leadMessages).toHaveLength(1);
    expect(leadMessages[0]).toMatchObject({ chat_id: "-100111" });
    expect(leadMessages[0]?.url).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    expect(leadMessages[0]?.text).toContain("New lead: Aura Cosmetics");
    expect(
      await rows(
        "SELECT status, attempts FROM notification_outbox WHERE id = ?;",
        [`lead-new:${id}`],
      ),
    ).toEqual([{ status: "SENT", attempts: 1 }]);
  });

  test("dua pengirim berlomba: hanya satu klaim yang menang", async () => {
    await client.execute(
      "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) VALUES ('race', 'LEAD_NEW', 'CS', '{}', datetime('now'), 'PENDING', 0, datetime('now'), datetime('now'));",
    );
    const first = await client.execute({
      sql: NOTIFICATION_CLAIM_SQL,
      args: ["race"],
    });
    const second = await client.execute({
      sql: NOTIFICATION_CLAIM_SQL,
      args: ["race"],
    });
    expect([first.rowsAffected, second.rowsAffected]).toEqual([1, 0]);
    await client.execute("DELETE FROM notification_outbox WHERE id = 'race';");
  });

  test("langkah tiket: hanya RND_REVIEW dan status Finance yang memberi tahu", async () => {
    const owner = await newLead();
    const { id } = await samples.createSampleRequest(
      client,
      {
        client_id: owner.id,
        product_category_option_id: categoryId,
        sample_qty: 2,
        brand_name: "Aura Glow",
        packaging: "Amber dropper 30 ml",
        deadline_at: "2026-10-31",
        ship_to_address: "Jl. Merdeka 1, Bandung",
        is_dummy_required: false,
        is_paid_sample: true,
        special_requests: {},
      },
      CS,
    );
    const step = (action: string, extra = {}) =>
      samples.recordSampleStep(
        client,
        { id, action, notes: `Step ${action}`, ...extra },
        CS,
      );
    await step("SUBMIT_TO_RND");
    await step("RND_ACCEPT", { lead_time_days: 7 });
    await step("PROCEED");
    const events = await rows(
      `SELECT n.event_type, n.target_division, n.status FROM notification_outbox n
       JOIN sample_status_log l ON n.id = 'sample:' || l.id
       WHERE l.sample_request_id = ? ORDER BY l.recorded_at, l.rowid;`,
      [id],
    );
    // Chat Finance kosong: tetap di lonceng, tidak ke Telegram.
    expect(events).toEqual([
      {
        event_type: "SAMPLE_RND_REVIEW",
        target_division: "RND",
        status: "PENDING",
      },
      {
        event_type: "SAMPLE_WAITING_PAYMENT",
        target_division: "FINANCE",
        status: "SKIPPED",
      },
    ]);
  });

  test("gagal lima kali menjadi FAILED dengan error Telegram; Retry failed mengirim ulang", async () => {
    await notifications.dispatchNotifications(client);
    reply = () =>
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: chat not found",
        }),
        {
          status: 400,
        },
      );
    const { id } = await newLead();
    const key = `lead-new:${id}`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await client.execute({
        sql: "UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?;",
        args: [key],
      });
      await notifications.dispatchNotifications(client);
    }
    expect(
      await rows(
        "SELECT status, attempts, last_error FROM notification_outbox WHERE id = ?;",
        [key],
      ),
    ).toEqual([
      {
        status: "FAILED",
        attempts: 5,
        last_error: "HTTP 400: Bad Request: chat not found",
      },
    ]);
    const settings = await notifications.getTelegramSettings(client);
    expect(settings.failed.map((row) => row.id)).toEqual([key]);

    reply = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const after = await notifications.retryFailedNotifications(client);
    expect(after.failed).toEqual([]);
    expect(
      await rows("SELECT status FROM notification_outbox WHERE id = ?;", [key]),
    ).toEqual([{ status: "SENT" }]);
  });

  test("lonceng: hanya divisi yang boleh dilihat; membuka = semua dibaca", async () => {
    const cs = await notifications.listNotifications(
      client,
      [true, false, false],
      7,
    );
    expect(cs.items.length).toBeGreaterThan(0);
    expect(cs.items.every((item) => item.target_division === "CS")).toBe(true);
    expect(cs.unread).toBe(cs.items.length);
    expect(cs.items[0]?.text).toContain("New lead:");
    expect(cs.items[0]?.client_id).not.toBe("");

    const rnd = await notifications.listNotifications(
      client,
      [false, true, false],
      7,
    );
    expect(rnd.items.map((item) => item.event_type)).toEqual([
      "SAMPLE_RND_REVIEW",
    ]);
    expect(rnd.items[0]?.sample_id).not.toBe("");

    await notifications.markNotificationsSeen(client, 7);
    expect(
      (await notifications.listNotifications(client, [true, true, true], 7))
        .unread,
    ).toBe(0);
    // Penanda dibaca per operator, bukan global.
    expect(
      (await notifications.listNotifications(client, [true, true, true], 1))
        .unread,
    ).toBeGreaterThan(0);
  });

  test("ringkasan Cold sekali per tanggal perusahaan, mulai pukul 08.00", async () => {
    const now = Number(
      (
        await client.execute(
          "SELECT CAST(strftime('%s','now') AS INTEGER) AS now;",
        )
      ).rows[0]?.now,
    );
    const { date, hour } = companyClock(now, "Asia/Jakarta");
    // Respons terakhir 8 hari kalender lalu = menjadi Cold hari ini (warm 7).
    const respondedOn = new Date(`${date}T00:00:00Z`);
    respondedOn.setUTCDate(respondedOn.getUTCDate() - 8);
    const bounds = companyDayBoundsUtc(
      respondedOn.toISOString().slice(0, 10),
      "Asia/Jakarta",
    );
    const { id, client_code } = await newLead();
    await client.execute({
      sql: "UPDATE leads SET last_client_response_at = ? WHERE client_id = ?;",
      args: [bounds?.[0] ?? "", id],
    });
    // Dispatch di tes sebelumnya sudah memutuskan ringkasan hari ini (kosong);
    // satu tanggal hanya punya satu ringkasan. Mulai dari pengirim pertama hari ini.
    await client.execute(
      "DELETE FROM notification_outbox WHERE id LIKE 'cold-digest:%';",
    );
    await notifications.dispatchNotifications(client);
    await notifications.dispatchNotifications(client);
    const digests = await rows(
      "SELECT payload_json, status FROM notification_outbox WHERE id = ?;",
      [`cold-digest:${date}`],
    );
    if (hour < COLD_DIGEST_HOUR) {
      expect(digests).toEqual([]);
      return;
    }
    expect(digests).toHaveLength(1);
    expect(String(digests[0]?.payload_json)).toContain(client_code);
    expect(digests[0]?.status).toBe("SENT");
    expect(
      sent.filter((message) => message.text.startsWith("Leads that went Cold")),
    ).toHaveLength(1);
  });
});
