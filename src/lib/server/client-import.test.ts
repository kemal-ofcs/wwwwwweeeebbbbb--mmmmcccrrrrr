import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import type { ImportRowInput } from "@/lib/validations/client-import";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

const clients = await import("@/lib/server/clients");
const notifications = await import("@/lib/server/notifications");
const business = await import("@/lib/server/business-settings");
const { importClients } = await import("@/lib/server/client-import");

let client: Client;
let directory: string;
let channelId: string;
let categoryId: string;

function row(
  line: number,
  change: Partial<ImportRowInput> = {},
): ImportRowInput {
  return {
    line,
    client_code: `GNI-${String(line).padStart(4, "0")}`,
    name: `Klien ${line}`,
    phone: `0813${String(line).padStart(8, "0")}`,
    address: "",
    city: "Bandung",
    province: "Jawa Barat",
    needs_notes: "Serum 30 ml",
    channel_option_id: channelId,
    product_category_option_id: categoryId,
    pic_cs_id: 7,
    lead_created_at: "1/15/2026 10:00",
    last_update: "2/1/2026",
    total_followups: "3",
    pic_answer: "",
    ...change,
  };
}

async function count(sql: string, args: (string | number)[] = []) {
  const result = await client.execute({ sql, args });
  return Number(result.rows[0]?.total ?? 0);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "client-import-test-"));
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
      { kind: "LEAD_CHANNEL", code: "META", label: "Meta" },
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
  // Bot aktif dan grup CS terisi: impor tetap TIDAK boleh memberi tahu.
  await notifications.saveTelegramConfig(
    client,
    { bot_token: TOKEN, is_active: true },
    "SPD001",
  );
  await business.saveBusinessSettings(
    client,
    {
      default_free_revision_limit: 1,
      sample_fee_mode: "PER_REQUEST",
      lead_hot_max_days: 3,
      lead_warm_max_days: 7,
      max_photos_per_sample: 10,
      telegram_chat_id_cs: "-100111",
      telegram_chat_id_rnd: "",
      telegram_chat_id_finance: "",
      offline_login_max_days: 7,
      default_sample_fee_idr: 0,
      default_test_fee_idr: 0,
      invoice_due_days: 7,
      invoice_payment_instructions: "",
      telegram_chat_id_design: "",
      telegram_chat_id_production: "",
      default_dummy_fee_idr: 0,
      max_dummy_rejections: 0,
      storage_grace_days: 14,
      storage_fee_idr: 0,
      storage_sop_text: "",
      dp_percentage_bp: 5000,
      approval_web_url: "",
      approval_token_ttl_days: 3,
    },
    ADMIN,
  );
});

afterAll(() => {
  client.close();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows: libsql baru melepas berkas database saat proses selesai, jadi
    // penghapusan di sini gagal EBUSY. Folder temp boleh tertinggal.
  }
});

describe("impor CSV, jalur Web", () => {
  test("kriteria terima: 1000 baris dengan 10 rusak, simpan tepat 990, impor ulang 0", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      row(index + 2, (index + 1) % 100 === 0 ? { phone: "12345" } : {}),
    );
    const request = { file_name: "cs-rina.csv", date_order: "MDY", rows };

    const preview = await importClients(
      client,
      { ...request, dry_run: true },
      ADMIN,
    );
    expect(preview).toMatchObject({
      dry_run: true,
      total: 1000,
      added: 990,
      skipped: 0,
      invalid: 10,
    });
    expect(preview.results[0]).toEqual({
      line: 101,
      status: "invalid",
      message: "Enter a valid WhatsApp number that starts with 0 or 62.",
    });
    // Pratinjau tidak menulis apa pun.
    expect(await count("SELECT COUNT(*) AS total FROM clients;")).toBe(0);

    const saved = await importClients(
      client,
      { ...request, dry_run: false },
      ADMIN,
    );
    expect(saved).toMatchObject({ dry_run: false, added: 990, invalid: 10 });
    expect(await count("SELECT COUNT(*) AS total FROM clients;")).toBe(990);
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM leads WHERE total_followups = 3 AND pic_cs_id = 7;",
      ),
    ).toBe(990);

    const again = await importClients(
      client,
      { ...request, dry_run: false },
      ADMIN,
    );
    expect(again).toMatchObject({ added: 0, skipped: 990, invalid: 10 });
    expect(await count("SELECT COUNT(*) AS total FROM clients;")).toBe(990);

    // Satu entri audit per impor yang menyimpan (FR-09.7), tanpa notifikasi (keputusan I).
    const audit = await client.execute(
      "SELECT summary_json FROM domain_audit_log WHERE action = 'client.import';",
    );
    expect(
      audit.rows.map((row) => JSON.parse(String(row.summary_json))),
    ).toEqual([
      { file_name: "cs-rina.csv", added: 990, skipped: 0, invalid: 10 },
    ]);
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM notification_outbox WHERE id LIKE 'lead-new:%';",
      ),
    ).toBe(0);
  });

  test("Jawaban PIC jadi interaksi INBOUND tanpa mengubah Jumlah FU; kode kosong dibuatkan", async () => {
    const result = await importClients(
      client,
      {
        file_name: "tes-maklon.csv",
        date_order: "MDY",
        dry_run: false,
        rows: [
          row(2, {
            client_code: "",
            phone: "812-9999-0001",
            pic_answer: "Sudah kirim pricelist, klien minta sampel",
            pic_cs_id: null,
          }),
          // Nomor sama boleh dipakai beberapa klien: diimpor dengan catatan.
          row(3, { client_code: "GNI-9001", phone: "0812-9999-0001" }),
          row(4, { client_code: "gni-0002", phone: "0812-9999-0002" }),
        ],
      },
      ADMIN,
    );
    expect(result).toMatchObject({ added: 2, skipped: 1, invalid: 0 });
    expect(result.warnings).toEqual([
      {
        line: 3,
        message:
          "The WhatsApp number 6281299990001 appears more than once in this file.",
      },
    ]);
    const imported = await client.execute({
      sql: `SELECT c.client_code, l.pic_cs_id, l.total_followups, l.last_client_response_at,
                   i.direction, i.kind, i.notes, i.occurred_at
            FROM clients c JOIN leads l ON l.client_id = c.id
            JOIN lead_interactions i ON i.lead_id = l.id
            WHERE c.phone_normalized = '6281299990001';`,
      args: [],
    });
    expect({ ...imported.rows[0] }).toMatchObject({
      pic_cs_id: 1,
      total_followups: 3,
      last_client_response_at: "2026-01-31 17:00:00",
      direction: "INBOUND",
      kind: "OTHER",
      notes: "Imported from sheet: Sudah kirim pricelist, klien minta sampel",
      occurred_at: "2026-01-31 17:00:00",
    });
    expect(String(imported.rows[0]?.client_code)).toMatch(/^KLN-\d{8}-WB01$/);
  });

  test("opsi nonaktif, PIC tak dikenal, dan urutan tanggal yang tidak dipilih ditolak", async () => {
    const result = await importClients(
      client,
      {
        date_order: "MDY",
        dry_run: true,
        rows: [
          row(2, {
            client_code: "GNI-8001",
            phone: "0812-8888-0001",
            channel_option_id: "missing",
          }),
          row(3, {
            client_code: "GNI-8002",
            phone: "0812-8888-0002",
            pic_cs_id: 99,
          }),
        ],
      },
      ADMIN,
    );
    expect(result.results.map((entry) => entry.message)).toEqual([
      "The lead source is not an active Master Data lead channel.",
      "The PIC is not an active operator.",
    ]);
    await expect(
      importClients(client, { date_order: "YMD", rows: [row(2)] }, ADMIN),
    ).rejects.toThrow("Choose the date order used in the sheet.");
  });
});
