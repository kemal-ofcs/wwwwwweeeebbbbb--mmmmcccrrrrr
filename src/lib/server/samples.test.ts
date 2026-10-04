import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import {
  FINANCE_PERMISSION_SEED_SQL,
  initDatabaseSchema,
  RND_PERMISSION_SEED_SQL,
  SAMPLE_PERMISSION_SEED_SQL,
} from "@/lib/db-schema";
import * as rules from "@/lib/validations/sample";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const CS = { id: 7, role: "CS" };

const clients = await import("@/lib/server/clients");
const samples = await import("@/lib/server/samples");
const business = await import("@/lib/server/business-settings");

let client: Client;
let directory: string;
let categoryId: string;
let channelId: string;
let reasonId: string;

function rustSource(file: string) {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/${file}`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  return readFileSync(path as string, "utf8");
}

async function lifecycle(id: string) {
  const result = await client.execute({
    sql: "SELECT lifecycle_status, free_revision_limit FROM clients WHERE id = ?;",
    args: [id],
  });
  return { ...result.rows[0] };
}

async function newClient(phone: string) {
  return clients.registerClient(
    client,
    {
      name: "Aura Cosmetics",
      phone,
      channel_option_id: channelId,
      product_category_option_id: categoryId,
    },
    CS,
  );
}

function draft(clientId: string, overrides: Record<string, unknown> = {}) {
  return {
    client_id: clientId,
    product_category_option_id: categoryId,
    sample_qty: 2,
    brand_name: "Aura Glow",
    packaging: "Amber dropper 30 ml",
    deadline_at: "2026-10-31",
    ship_to_address: "Jl. Merdeka 1, Bandung",
    is_dummy_required: false,
    is_paid_sample: false,
    special_requests: { aroma: "Rose" },
    ...overrides,
  };
}

// Isian RnD bawaan per langkah (v2.1); `extra.rnd` menggantinya.
function rndFor(action: string) {
  if (action === "RND_ACCEPT") return { product_class: "NEW" };
  if (action === "RND_REJECT") return { reject_reason_option_id: reasonId };
  if (action === "SAMPLE_READY")
    return { formula_code: "FRM-001", product_knowledge: "Light gel" };
  return {};
}

async function step(id: string, action: string, extra = {}) {
  return samples.recordSampleStep(
    client,
    { id, action, notes: `Step ${action}`, rnd: rndFor(action), ...extra },
    CS,
  );
}

const FINANCE = { id: 1, role: "Finance" };
const COSTS = {
  raw_material_cost_idr: 8420,
  packaging_cost_idr: 7850,
  operational_cost_idr: 2450,
  regulatory_cost_idr: 780,
  margin_bp: 4000,
  notes: "10k pcs",
};

// Harga Finance untuk iterasi yang sedang `SAMPLE_READY` (v2.2, gerbang D-27).
async function price(id: string, overrides = {}) {
  return samples.recordSamplePrice(
    client,
    { id, price: { ...COSTS, ...overrides } },
    FINANCE,
  );
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "samples-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active'),
            (7, 'OP7', 'Rina CS', 'rina', 'x', 'Active'),
            (8, 'OP8', 'Dewi CRM', 'dewi', 'x', 'Active');`,
  );
  await client.execute(
    "UPDATE master_operator SET role_id = (SELECT id FROM app_role WHERE role_key = 'crm') WHERE id = 8;",
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
  reasonId = (
    await clients.saveMasterOption(
      client,
      {
        kind: "RND_REJECT_REASON",
        code: "CAP",
        label: "Factory machine capacity",
      },
      ADMIN,
    )
  ).id;
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

describe("tiket sampel, jalur Web", () => {
  test("SQL tiket, siklus hidup klien, dan seed izin identik dengan Rust", () => {
    const samplesRs = rustSource("samples.rs");
    for (const sql of [
      rules.CLIENT_LIFECYCLE_FROM_SAMPLES_SQL,
      rules.SAMPLE_INSERT_SQL,
      rules.SAMPLE_UPDATE_SQL,
      rules.SAMPLE_TRANSITION_SQL,
      rules.SAMPLE_STATUS_LOG_INSERT_SQL,
      rules.SAMPLE_FEEDBACK_INSERT_SQL,
      rules.SAMPLE_FORMULA_INSERT_SQL,
      rules.SAMPLE_FORMULAS_SQL,
      rules.SAMPLE_FORMULA_MATCHES_SQL,
      rules.SAMPLE_LIST_SQL,
      rules.PRICE_INSERT_SQL,
      rules.PRICES_SQL,
    ]) {
      expect(samplesRs).toContain(`"${sql}"`);
    }
    expect(samplesRs).toContain(`"${rules.SAMPLE_CHANGED_ELSEWHERE}"`);
    const tursoRs = rustSource("turso.rs");
    for (const sql of [
      ...SAMPLE_PERMISSION_SEED_SQL,
      ...RND_PERMISSION_SEED_SQL,
      ...FINANCE_PERMISSION_SEED_SQL,
    ]) {
      expect(tursoRs).toContain(`"${sql}"`);
    }
  });

  test("setelan kuota berlaku untuk klien yang dibuat sesudahnya saja", async () => {
    const before = await newClient("081200000001");
    expect(await lifecycle(before.id)).toMatchObject({
      free_revision_limit: 1,
    });
    await business.saveBusinessSettings(
      client,
      {
        default_free_revision_limit: 2,
        sample_fee_mode: "PER_REQUEST",
        lead_hot_max_days: 3,
        lead_warm_max_days: 7,
        max_photos_per_sample: 10,
        telegram_chat_id_cs: "",
        telegram_chat_id_rnd: "",
        telegram_chat_id_finance: "",
        offline_login_max_days: 7,
      },
      ADMIN,
    );
    const after = await newClient("081200000002");
    expect(await lifecycle(after.id)).toMatchObject({ free_revision_limit: 2 });
    expect(await lifecycle(before.id)).toMatchObject({
      free_revision_limit: 1,
    });
  });

  test("alur penuh: kuota 1, revisi pertama gratis, kedua menunggu Finance", async () => {
    const owner = await newClient("081200000003");
    await clients.updateClient(
      client,
      {
        id: owner.id,
        name: "Aura Cosmetics",
        phone: "081200000003",
        channel_option_id: channelId,
        product_category_option_id: categoryId,
        free_revision_limit: 1,
      },
      ADMIN,
    );
    const { id } = await samples.createSampleRequest(
      client,
      draft(owner.id, { is_paid_sample: true, pic_crm_id: 8 }),
      CS,
    );
    expect(await lifecycle(owner.id)).toMatchObject({
      lifecycle_status: "FIRST_ORDER_ACTIVE",
    });

    await step(id, "SUBMIT_TO_RND");
    await expect(step(id, "RND_ACCEPT")).rejects.toThrow(
      "Enter the RnD lead time in days (1-365).",
    );
    await step(id, "RND_ACCEPT", { lead_time_days: 14 });
    expect(await step(id, "PROCEED")).toEqual({
      status: "WAITING_SAMPLE_PAYMENT",
      revision_index: 0,
    });
    await step(id, "PAYMENT_RECEIVED");
    await step(id, "SAMPLE_READY");
    await price(id);
    await step(id, "SAMPLE_SENT");
    expect(await step(id, "CLIENT_REVISE")).toEqual({
      status: "IN_RND",
      revision_index: 1,
    });
    await step(id, "SAMPLE_READY");
    await price(id);
    await step(id, "SAMPLE_SENT");
    expect(await step(id, "CLIENT_REVISE")).toEqual({
      status: "PENDING_FEE_ASSESSMENT",
      revision_index: 2,
    });
    await expect(step(id, "PAYMENT_RECEIVED")).rejects.toThrow(
      rules.SAMPLE_STEP_NOT_ALLOWED,
    );

    const detail = await samples.getSampleRequest(client, id, true);
    expect(detail.request).toMatchObject({
      status: "PENDING_FEE_ASSESSMENT",
      revision_index: 2,
      is_billable: 1,
      rnd_lead_time_days: 14,
      pic_crm_name: "Dewi CRM",
    });
    expect(
      detail.feedbacks.map((row) => [
        row.iteration_number,
        row.client_decision,
      ]),
    ).toEqual([
      [1, "REVISE"],
      [2, "REVISE"],
    ]);
    // Langkah RnD dan Finance tercatat atas nama divisinya (D-23).
    const byAction = Object.fromEntries(
      detail.status_log.map((row) => [row.action, row.on_behalf_of_division]),
    );
    expect(byAction.RND_ACCEPT).toBe("RnD");
    expect(byAction.PAYMENT_RECEIVED).toBe("Finance");
    expect(byAction.SUBMIT_TO_RND).toBe("CS");
    const audit = await client.execute({
      sql: "SELECT on_behalf_of_division FROM domain_audit_log WHERE entity_id = ? AND action = 'sample.step' AND summary_json LIKE '%RND_ACCEPT%';",
      args: [id],
    });
    expect(String(audit.rows[0]?.on_behalf_of_division)).toBe("RnD");
  });

  test("spesifikasi terkunci setelah dikirim ke RnD; deadline tetap bisa diubah", async () => {
    const owner = await newClient("081200000004");
    const { id } = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    await samples.updateSampleRequest(
      client,
      { ...draft(owner.id, { brand_name: "Aura Night" }), id },
      CS,
    );
    await step(id, "SUBMIT_TO_RND");
    await samples.updateSampleRequest(
      client,
      {
        ...draft(owner.id, {
          brand_name: "Changed",
          deadline_at: "2026-11-30",
        }),
        id,
      },
      CS,
    );
    const { request } = await samples.getSampleRequest(client, id, true);
    expect(request).toMatchObject({
      brand_name: "Aura Night",
      deadline_at: "2026-11-30",
    });
  });

  test("langkah dihitung dari status tiket saat ini; tiket tertutup menolak langkah", async () => {
    const owner = await newClient("081200000005");
    const { id } = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    // Perangkat lain sudah memindahkan tiket (tiba lewat sync).
    await client.execute({
      sql: "UPDATE sample_requests SET status = 'RND_REVIEW' WHERE id = ?;",
      args: [id],
    });
    await expect(step(id, "CANCEL")).resolves.toMatchObject({
      status: "CANCELLED",
    });
    await expect(step(id, "CANCEL")).rejects.toThrow(
      rules.SAMPLE_STEP_NOT_ALLOWED,
    );
  });

  test("klien kembali LEAD bila semua tiketnya ditolak atau dibatalkan", async () => {
    const owner = await newClient("081200000006");
    const first = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    const second = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    await step(first.id, "SUBMIT_TO_RND");
    await step(first.id, "RND_REJECT");
    expect(await lifecycle(owner.id)).toMatchObject({
      lifecycle_status: "FIRST_ORDER_ACTIVE",
    });
    await step(second.id, "CANCEL");
    expect(await lifecycle(owner.id)).toMatchObject({
      lifecycle_status: "LEAD",
    });
  });

  test("referensi yang tidak sah ditolak dengan pesan yang sama seperti Rust", async () => {
    const owner = await newClient("081200000007");
    await expect(
      samples.createSampleRequest(
        client,
        draft(owner.id, { pic_crm_id: 7 }),
        CS,
      ),
    ).rejects.toThrow("Choose an active CRM operator.");
    await expect(
      samples.createSampleRequest(
        client,
        draft(owner.id, { sample_kind_option_id: categoryId }),
        CS,
      ),
    ).rejects.toThrow("Choose an active sample kind.");
    await expect(
      samples.createSampleRequest(client, draft("missing"), CS),
    ).rejects.toThrow("Client not found.");
  });

  test("langkah RnD: klasifikasi, alasan tolak, dan formula per iterasi", async () => {
    const owner = await newClient("081200000008");
    const { id } = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    await step(id, "SUBMIT_TO_RND");
    await expect(
      step(id, "RND_ACCEPT", { lead_time_days: 7, rnd: {} }),
    ).rejects.toThrow("Choose whether this is a new or an existing product.");
    await step(id, "RND_ACCEPT", {
      lead_time_days: 7,
      rnd: { product_class: "EXISTING" },
    });
    await step(id, "PROCEED");
    await expect(
      step(id, "SAMPLE_READY", { rnd: { formula_code: "FRM-001" } }),
    ).rejects.toThrow("Enter the product knowledge, up to 2000 characters.");
    await step(id, "SAMPLE_READY", {
      rnd: { formula_code: "FRM-RND-1", product_knowledge: "Light gel" },
    });
    await price(id);
    await step(id, "SAMPLE_SENT");
    await step(id, "CLIENT_REVISE");
    await step(id, "SAMPLE_READY", {
      rnd: { formula_code: "FRM-002", product_knowledge: "Thicker gel" },
    });

    const detail = await samples.getSampleRequest(client, id, true);
    expect(detail.request).toMatchObject({ rnd_product_class: "EXISTING" });
    expect(
      detail.formulas.map((row) => [
        row.iteration_number,
        row.formula_code,
        row.rnd_notes,
      ]),
    ).toEqual([
      [1, "FRM-RND-1", "Step SAMPLE_READY"],
      [2, "FRM-002", "Step SAMPLE_READY"],
    ]);

    // Kode formula tidak unik: tiket lain dengan kode yang sama ditautkan,
    // tanpa membedakan huruf besar-kecil.
    const other = await samples.createSampleRequest(
      client,
      draft(owner.id, { brand_name: "Aura Night" }),
      CS,
    );
    await step(other.id, "SUBMIT_TO_RND");
    await step(other.id, "RND_ACCEPT", { lead_time_days: 3 });
    await step(other.id, "PROCEED");
    await step(other.id, "SAMPLE_READY", {
      rnd: { formula_code: "frm-rnd-1", product_knowledge: "Same base" },
    });
    const matches = await samples.getSampleRequest(client, other.id, true);
    expect(
      matches.formula_matches.map((row) => [
        row.formula_code,
        row.sample_request_id,
      ]),
    ).toEqual([["FRM-RND-1", id]]);

    // Menolak wajib alasan aktif dari Master Data.
    const rejected = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    await step(rejected.id, "SUBMIT_TO_RND");
    await expect(
      step(rejected.id, "RND_REJECT", {
        rnd: { reject_reason_option_id: categoryId },
      }),
    ).rejects.toThrow("Choose an active rejection reason.");
    await step(rejected.id, "RND_REJECT");
    const closed = await samples.getSampleRequest(client, rejected.id, true);
    expect(closed.request).toMatchObject({
      status: "RND_REJECTED",
      rnd_reject_reason_option_id: reasonId,
      rnd_product_class: "",
    });
  });

  test("Finance: gerbang harga, tarif revisi, dan rincian HPP per izin", async () => {
    const owner = await newClient("081200000009");
    await clients.updateClient(
      client,
      {
        id: owner.id,
        name: "Aura Cosmetics",
        phone: "081200000009",
        channel_option_id: channelId,
        product_category_option_id: categoryId,
        free_revision_limit: 0,
      },
      ADMIN,
    );
    const { id } = await samples.createSampleRequest(
      client,
      draft(owner.id),
      CS,
    );
    await step(id, "SUBMIT_TO_RND");
    await expect(price(id)).rejects.toThrow(
      "Only a sample that is ready can be priced.",
    );
    await step(id, "RND_ACCEPT", { lead_time_days: 5 });
    await step(id, "PROCEED");
    await step(id, "SAMPLE_READY");
    await expect(step(id, "SAMPLE_SENT")).rejects.toThrow(
      rules.SAMPLE_NOT_PRICED,
    );
    await expect(price(id, { margin_bp: 9600 })).rejects.toThrow(
      "The margin must be from 0% to 95%.",
    );
    // Koreksi harga: baris terbaru untuk iterasi itu yang berlaku.
    await price(id, { margin_bp: 3000 });
    expect(await price(id)).toMatchObject({ final_unit_price_idr: 32_500 });
    expect(
      (await samples.getSampleRequest(client, id, true)).request,
    ).toMatchObject({ unit_price_idr: 32_500 });
    await step(id, "SAMPLE_SENT");

    // Kuota 0: revisi pertama menunggu tarif Finance.
    await step(id, "CLIENT_REVISE");
    await expect(step(id, "SET_REVISION_FEE")).rejects.toThrow(
      rules.REVISION_FEE_INVALID,
    );
    expect(
      await step(id, "SET_REVISION_FEE", { revision_fee_idr: 750_000 }),
    ).toEqual({ status: "WAITING_REVISION_PAYMENT", revision_index: 1 });
    await step(id, "PAYMENT_RECEIVED");
    await step(id, "SAMPLE_READY");
    // Iterasi baru belum punya harga; harga iterasi 1 tidak berlaku lagi.
    await expect(step(id, "SAMPLE_SENT")).rejects.toThrow(
      rules.SAMPLE_NOT_PRICED,
    );

    const full = await samples.getSampleRequest(client, id, true);
    expect(full.request).toMatchObject({
      revision_fee_idr: 750_000,
      unit_price_idr: null,
    });
    expect(full.prices[full.prices.length - 1]).toMatchObject({
      iteration_number: 1,
      hpp_unit_idr: 19_500,
      margin_bp: 4000,
      final_unit_price_idr: 32_500,
      notes: "10k pcs",
    });
    // Tanpa `pricing.view`: harga jual tetap ada, rincian HPP dan margin tidak.
    const limited = await samples.getSampleRequest(client, id, false);
    const visible = limited.prices[limited.prices.length - 1] ?? {};
    expect(visible).toMatchObject({ final_unit_price_idr: 32_500 });
    for (const column of rules.PRICE_COST_COLUMNS) {
      expect(column in visible).toBe(false);
    }

    const events = await client.execute({
      sql: "SELECT event_type, target_division FROM notification_outbox WHERE payload_json LIKE ? ORDER BY created_at, rowid;",
      args: [`%${id}%`],
    });
    const byEvent = events.rows.map((row) => [
      String(row.event_type),
      String(row.target_division),
    ]);
    expect(byEvent).toContainEqual(["SAMPLE_READY", "FINANCE"]);
    expect(byEvent).toContainEqual(["SAMPLE_PRICED", "CS"]);
    expect(byEvent).toContainEqual(["SAMPLE_REVISION_FEE", "CS"]);
  });

  test("izin Finance untuk role Finance, sekali saja", async () => {
    const granted = await client.execute(
      `SELECT rp.permission_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE r.role_key = 'finance' AND rp.permission_key IN ('finance.manage', 'pricing.view', 'samples.view', 'samples.manage', 'clients.view')
       ORDER BY rp.permission_key;`,
    );
    expect(granted.rows.map((row) => String(row.permission_key))).toEqual([
      "clients.view",
      "finance.manage",
      "pricing.view",
      "samples.view",
    ]);
    const cs = await client.execute(
      "SELECT COUNT(*) AS total FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE r.role_key = 'cs' AND rp.permission_key IN ('finance.manage', 'pricing.view');",
    );
    expect(Number(cs.rows[0]?.total)).toBe(0);
  });

  test("izin RnD untuk role RnD, sekali saja", async () => {
    const granted = await client.execute(
      `SELECT rp.permission_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE r.role_key = 'rnd' AND rp.permission_key IN ('rnd.manage', 'samples.view', 'samples.manage', 'clients.view')
       ORDER BY rp.permission_key;`,
    );
    expect(granted.rows.map((row) => String(row.permission_key))).toEqual([
      "clients.view",
      "rnd.manage",
      "samples.view",
    ]);
    const cs = await client.execute(
      "SELECT COUNT(*) AS total FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE r.role_key = 'cs' AND rp.permission_key = 'rnd.manage';",
    );
    expect(Number(cs.rows[0]?.total)).toBe(0);
  });

  test("izin tiket untuk CS dan CRM, sekali saja", async () => {
    const packages = await client.execute(
      `SELECT r.role_key, group_concat(rp.permission_key) AS keys
       FROM app_role r JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE r.role_key IN ('cs', 'crm') AND rp.permission_key LIKE 'samples.%'
       GROUP BY r.role_key ORDER BY r.role_key;`,
    );
    expect(
      packages.rows.map((row) => [
        String(row.role_key),
        String(row.keys).split(",").sort().join(","),
      ]),
    ).toEqual([
      ["crm", "samples.view"],
      ["cs", "samples.manage,samples.view"],
    ]);
  });
});
