import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import {
  DESIGN_PERMISSION_SEED_SQL,
  FINANCE_PERMISSION_SEED_SQL,
  initDatabaseSchema,
  LEGAL_PERMISSION_SEED_SQL,
  MOU_PERMISSION_SEED_SQL,
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
const finance = await import("@/lib/server/finance");
const media = await import("@/lib/server/media");
const design = await import("@/lib/validations/design");
const mou = await import("@/lib/server/mou");
const approval = await import("@/lib/server/approval");
const legal = await import("@/lib/server/legal");

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
    {
      id,
      action,
      notes: `Step ${action}`,
      rnd: rndFor(action),
      evidence_base64: EVIDENCE,
      ...extra,
    },
    CS,
  );
}

const FINANCE = { id: 1, role: "Finance" };
// Tangkapan layar balasan klien (v2.5b, keputusan N); diabaikan di langkah lain.
const EVIDENCE = "UklGRgwAAABXRUJQVlA4TA==";
const COSTS = {
  raw_material_cost_idr: 8420,
  packaging_cost_idr: 7850,
  operational_cost_idr: 2450,
  regulatory_cost_idr: 780,
  margin_bp: 4000,
  notes: "10k pcs",
};

// Tagihan yang dibayar penuh (v2.3a): buat, catat uang masuk, alokasikan.
async function settle(id: string, refType: string, amount: number) {
  const invoice = await finance.createInvoice(
    client,
    {
      ref_type: refType,
      sample_request_id: id,
      subtotal_idr: amount,
      tax_option_ids: [],
    },
    FINANCE,
  );
  const fund = await finance.recordIncomingFund(
    client,
    { received_on: "2026-10-08", amount_idr: invoice.total_idr },
    FINANCE,
  );
  await finance.allocateFund(
    client,
    { fund_id: fund.id, invoice_id: invoice.id, amount_idr: invoice.total_idr },
    FINANCE,
  );
}

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
      ...DESIGN_PERMISSION_SEED_SQL,
      ...MOU_PERMISSION_SEED_SQL,
      ...LEGAL_PERMISSION_SEED_SQL,
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
        default_sample_fee_idr: 150_000,
        default_test_fee_idr: 250_000,
        invoice_due_days: 14,
        invoice_payment_instructions: "BCA 123",
        telegram_chat_id_design: "",
        default_dummy_fee_idr: 0,
        max_dummy_rejections: 0,
        dp_percentage_bp: 5000,
        approval_web_url: "",
        approval_token_ttl_days: 3,
      },
      ADMIN,
    );
    // Setiap kunci tersimpan, termasuk setelan invoice (pernah tertinggal).
    expect(await business.loadBusinessSettings(client)).toMatchObject({
      default_free_revision_limit: 2,
      default_sample_fee_idr: 150_000,
      default_test_fee_idr: 250_000,
      invoice_due_days: 14,
      invoice_payment_instructions: "BCA 123",
    });
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
    // Gerbang v2.3a: pembayaran dicatat setelah tagihannya lunas.
    await expect(step(id, "PAYMENT_RECEIVED")).rejects.toThrow(
      rules.SAMPLE_FEE_UNPAID,
    );
    await settle(id, "SAMPLE_FEE", 250_000);
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
    await settle(id, "REVISION_FEE", 750_000);
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
  test("desain: gerbang mockup, gerbang bayar dummy, batas penolakan, dan notifikasi", async () => {
    const DESIGNER = { id: 9, role: "Design" };
    const TINY_WEBP = "UklGRgwAAABXRUJQVlA4TA==";
    const owner = await newClient("081200000090");
    const sample = await samples.createSampleRequest(
      client,
      draft(owner.id, { is_dummy_required: true, brand_name: "Aura Box" }),
      CS,
    );
    for (const action of [
      "SUBMIT_TO_RND",
      "RND_ACCEPT",
      "PROCEED",
      "SAMPLE_READY",
    ]) {
      await step(sample.id, action, { lead_time_days: 14 });
    }
    await price(sample.id);
    // Tiket meminta dummy: Sample sent menunggu mockup (D-36, keputusan B).
    await expect(step(sample.id, "SAMPLE_SENT")).rejects.toThrow(
      rules.SAMPLE_MOCKUP_MISSING,
    );
    await expect(
      media.uploadSampleMedia(
        client,
        { sample_id: sample.id, purpose: "MOCKUP", data_base64: TINY_WEBP },
        DESIGNER,
      ),
    ).rejects.toThrow(
      "Request a design for this sample before uploading a mockup.",
    );

    const ticket = await samples.createDesignTicket(
      client,
      { sample_id: sample.id, brief: " Box 50 ml, pastel " },
      CS,
    );
    await expect(
      samples.createDesignTicket(
        client,
        { sample_id: sample.id, brief: "Again" },
        CS,
      ),
    ).rejects.toThrow("This sample request already has a design ticket.");
    await media.uploadSampleMedia(
      client,
      { sample_id: sample.id, purpose: "MOCKUP", data_base64: TINY_WEBP },
      DESIGNER,
    );
    await step(sample.id, "SAMPLE_SENT");
    await step(sample.id, "CLIENT_ACC");

    const designStep = (
      action: string,
      extra: Record<string, unknown> = {},
      canOverride = false,
    ) =>
      samples.recordDesignStep(
        client,
        {
          id: ticket.id,
          action,
          notes: `Design ${action}`,
          evidence_base64: EVIDENCE,
          ...extra,
        },
        action === "PRINT_DUMMY" || action === "DUMMY_SENT" ? DESIGNER : CS,
        canOverride,
      );
    // Cetak pertama menunggu tagihan dummy lunas (US-17, keputusan D).
    await expect(designStep("PRINT_DUMMY")).rejects.toThrow(
      "The dummy invoice for this round is not paid yet.",
    );
    await settle(sample.id, "DUMMY_FEE", 75_000);
    expect(await designStep("PRINT_DUMMY")).toEqual({
      status: "DUMMY_PRINTING",
      rejection_count: 0,
    });
    await designStep("DUMMY_SENT", { tracking_no: " JNE123 " });

    await client.execute(
      "INSERT INTO setting_gex_system (key, value) VALUES ('max_dummy_rejections', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    );
    expect(await designStep("DUMMY_REVISE")).toEqual({
      status: "DUMMY_REVISION",
      rejection_count: 1,
    });
    // Batas tercapai: hanya pemegang izin override (keputusan E).
    await expect(designStep("PRINT_DUMMY")).rejects.toThrow(
      design.DUMMY_LIMIT_REACHED,
    );
    // Tagihan dummy putaran ini yang belum lunas menahan cetak ulang.
    const extra = await finance.createInvoice(
      client,
      {
        ref_type: "DUMMY_FEE",
        sample_request_id: sample.id,
        subtotal_idr: 50_000,
        tax_option_ids: [],
      },
      FINANCE,
    );
    await expect(designStep("PRINT_DUMMY", {}, true)).rejects.toThrow(
      "The dummy invoice for this round is not paid yet.",
    );
    const fund = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: extra.total_idr },
      FINANCE,
    );
    await finance.allocateFund(
      client,
      { fund_id: fund.id, invoice_id: extra.id, amount_idr: extra.total_idr },
      FINANCE,
    );
    expect(await designStep("PRINT_DUMMY", {}, true)).toEqual({
      status: "DUMMY_PRINTING",
      rejection_count: 1,
    });

    const row = await client.execute({
      sql: "SELECT brief, dummy_tracking_no, revision_notes FROM design_tickets WHERE id = ?;",
      args: [ticket.id],
    });
    const saved = row.rows[0];
    expect([
      saved?.brief,
      saved?.dummy_tracking_no,
      saved?.revision_notes,
    ]).toEqual(["Box 50 ml, pastel", "JNE123", "Design DUMMY_REVISE"]);
    const invoices = await client.execute({
      sql: "SELECT revision_index FROM invoices WHERE sample_request_id = ? AND ref_type = 'DUMMY_FEE' ORDER BY revision_index;",
      args: [sample.id],
    });
    expect(
      invoices.rows.map((invoice) => Number(invoice.revision_index)),
    ).toEqual([0, 1]);
    // Linimasa tiket sampel memuat langkah desain; override tercatat di audit.
    const detail = await samples.getSampleRequest(client, sample.id, false);
    expect(detail.design?.status).toBe("DUMMY_PRINTING");
    const designLog = detail.status_log
      .map((entry) => String(entry.action))
      .filter((action) =>
        [
          "REQUEST_DESIGN",
          "PRINT_DUMMY",
          "DUMMY_SENT",
          "DUMMY_REVISE",
        ].includes(action),
      )
      .reverse();
    expect(designLog).toEqual([
      "REQUEST_DESIGN",
      "PRINT_DUMMY",
      "DUMMY_SENT",
      "DUMMY_REVISE",
      "PRINT_DUMMY",
    ]);
    const audit = await client.execute(
      "SELECT summary_json FROM domain_audit_log WHERE action = 'design.step' ORDER BY occurred_at DESC, rowid DESC LIMIT 1;",
    );
    expect(JSON.parse(String(audit.rows[0]?.summary_json)).override_limit).toBe(
      true,
    );
    // Grup Desain: brief baru dan dummy direvisi (FR-08), di transaksi yang sama.
    const notified = await client.execute(
      "SELECT event_type FROM notification_outbox WHERE target_division = 'DESIGN' ORDER BY event_type;",
    );
    expect(notified.rows.map((item) => String(item.event_type))).toEqual([
      "DESIGN_REQUESTED",
      "DUMMY_REVISED",
    ]);
    await client.execute(
      "UPDATE setting_gex_system SET value = '0' WHERE key = 'max_dummy_rejections';",
    );
  });

  test("izin Desain untuk role Design, sekali saja", async () => {
    const granted = await client.execute(
      "SELECT rp.permission_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE r.role_key = 'design' AND rp.is_allowed = 1 AND rp.permission_key NOT IN ('home.view', 'dashboard.view', 'sync.view') ORDER BY rp.permission_key;",
    );
    expect(granted.rows.map((row) => String(row.permission_key))).toEqual([
      "clients.view",
      "design.manage",
      "notifications_design.view",
      "samples.view",
    ]);
    // Override batas ikut paket Admin, tidak ke role divisi (keputusan E).
    const override = await client.execute(
      "SELECT r.role_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE rp.permission_key = 'design.override_dummy_limit' ORDER BY r.id;",
    );
    expect(override.rows.map((item) => String(item.role_key))).toEqual([
      "superadmin",
      "admin",
    ]);
  });

  test("MoU: hanya sesudah klien ACC, harga dari sampel, dummy menahan kirim, DP lunas", async () => {
    const owner = await newClient("081200000091");
    const sample = await samples.createSampleRequest(
      client,
      draft(owner.id, { is_dummy_required: true, brand_name: "Aura MoU" }),
      CS,
    );
    for (const action of [
      "SUBMIT_TO_RND",
      "RND_ACCEPT",
      "PROCEED",
      "SAMPLE_READY",
    ]) {
      await step(sample.id, action, { lead_time_days: 14 });
    }
    await price(sample.id);
    const terms = {
      total_units: 10_000,
      unit_price_idr: 1,
      production_lead_time_days: 45,
      regulatory_path: "WITH_BPOM",
      dp_bp: 9000,
      notes: "Box 30 ml",
    };
    // MoU menunggu klien ACC sampel (keputusan C).
    await expect(
      mou.createMou(client, { sample_id: sample.id, terms }, CS, false),
    ).rejects.toThrow("The client has not approved the sample yet.");

    const ticket = await samples.createDesignTicket(
      client,
      { sample_id: sample.id, brief: "Box" },
      CS,
    );
    await media.uploadSampleMedia(
      client,
      {
        sample_id: sample.id,
        purpose: "MOCKUP",
        data_base64: "UklGRgwAAABXRUJQVlA4TA==",
      },
      { id: 9, role: "Design" },
    );
    await step(sample.id, "SAMPLE_SENT");
    await step(sample.id, "CLIENT_ACC");

    // CS tanpa `finance.manage`: harga dari harga sampel (19.500 / 60% =
    // 32.500), persen DP dari setelan (50%), bukan dari form (keputusan D).
    const created = await mou.createMou(
      client,
      { sample_id: sample.id, terms },
      CS,
      false,
    );
    expect(created.mou_number).toMatch(/^MOU-\d{8}-/);
    const row = async () =>
      (
        await client.execute({
          sql: "SELECT unit_price_idr, total_production_cost_idr, dp_bp, dp_amount_required_idr, status FROM production_mou WHERE id = ?;",
          args: [created.id],
        })
      ).rows[0];
    const first = await row();
    expect([
      first?.unit_price_idr,
      first?.total_production_cost_idr,
      first?.dp_bp,
      first?.dp_amount_required_idr,
    ]).toEqual([32_500, 325_000_000, 5000, 162_500_000]);
    await expect(
      mou.createMou(client, { sample_id: sample.id, terms }, CS, false),
    ).rejects.toThrow("This sample request already has a MoU.");

    // Finance mengubah harga dan DP; CS tidak bisa mengubah keduanya.
    await mou.updateMou(
      client,
      { id: created.id, terms: { ...terms, unit_price_idr: 30_000 } },
      FINANCE,
      false,
      true,
    );
    const priced = await row();
    expect([priced?.unit_price_idr, priced?.dp_bp]).toEqual([30_000, 9000]);

    // Dummy belum di-ACC: MoU belum boleh dikirim (E-20).
    const mouStep = (action: string) =>
      mou.recordMouStep(
        client,
        {
          id: created.id,
          action,
          notes: `MoU ${action}`,
          evidence_base64: EVIDENCE,
        },
        CS,
      );
    await expect(mouStep("SEND_MOU")).rejects.toThrow(
      "The client has not approved the packaging dummy yet.",
    );
    await settle(sample.id, "DUMMY_FEE", 75_000);
    for (const action of ["PRINT_DUMMY", "DUMMY_SENT", "DUMMY_ACC"]) {
      await samples.recordDesignStep(
        client,
        { id: ticket.id, action, notes: action, evidence_base64: EVIDENCE },
        CS,
        false,
      );
    }
    expect(await mouStep("SEND_MOU")).toEqual({ status: "SENT" });
    await expect(
      mou.updateMou(client, { id: created.id, terms }, CS, true, false),
    ).rejects.toThrow("Only a draft MoU can be changed.");
    // Jawaban klien yang dicatat staf wajib membawa tangkapan layar (N).
    await expect(
      mou.recordMouStep(
        client,
        { id: created.id, action: "MOU_REVISE", notes: "Bigger box" },
        CS,
      ),
    ).rejects.toThrow("Attach a screenshot of the client's reply.");
    expect(await mouStep("MOU_REVISE")).toEqual({ status: "DRAFT" });
    await mouStep("SEND_MOU");
    expect(await mouStep("MOU_ACCEPT")).toEqual({ status: "ACCEPTED" });

    // DP dari MoU yang disetujui; lunas = `dp_cleared`.
    const dp = await finance.createInvoice(
      client,
      {
        ref_type: "DP_PRODUCTION_LEGAL",
        sample_request_id: sample.id,
        subtotal_idr: 270_000_000,
        tax_option_ids: [],
      },
      FINANCE,
    );
    const fund = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-09", amount_idr: dp.total_idr },
      FINANCE,
    );
    await finance.allocateFund(
      client,
      { fund_id: fund.id, invoice_id: dp.id, amount_idr: dp.total_idr },
      FINANCE,
    );
    const detail = await samples.getSampleRequest(client, sample.id, false);
    expect([detail.mou?.status, detail.mou?.dp_cleared]).toEqual([
      "ACCEPTED",
      1,
    ]);
    expect(detail.request.dp_paid).toBe(1);
    const log = detail.status_log
      .map((entry) => String(entry.action))
      .filter((action) => action.includes("MOU"))
      .reverse();
    expect(log).toEqual([
      "CREATE_MOU",
      "SEND_MOU",
      "MOU_REVISE",
      "SEND_MOU",
      "MOU_ACCEPT",
    ]);
    // Grup Finance diberi tahu sekali, saat MoU disetujui.
    const notified = await client.execute(
      "SELECT event_type FROM notification_outbox WHERE event_type = 'MOU_ACCEPTED';",
    );
    expect(notified.rows.length).toBe(1);
  });

  test("izin MoU untuk role CS dan Operator, sekali saja", async () => {
    const granted = await client.execute(
      "SELECT r.role_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE rp.permission_key = 'mou.manage' AND rp.is_allowed = 1 ORDER BY r.id;",
    );
    expect(granted.rows.map((item) => String(item.role_key))).toEqual([
      "superadmin",
      "admin",
      "operator",
      "cs",
    ]);
  });

  test("tautan persetujuan: sekali pakai, menggantikan tautan lama, gugur bila dicatat manual", async () => {
    const owner = await newClient("081200000092");
    const sentSample = async (brand: string) => {
      const created = await samples.createSampleRequest(
        client,
        draft(owner.id, { brand_name: brand }),
        CS,
      );
      for (const action of [
        "SUBMIT_TO_RND",
        "RND_ACCEPT",
        "PROCEED",
        "SAMPLE_READY",
      ]) {
        await step(created.id, action, { lead_time_days: 14 });
      }
      await price(created.id);
      await step(created.id, "SAMPLE_SENT");
      return created.id;
    };
    const tokenOf = (url: string) => new URL(url).searchParams.get("t") ?? "";
    const link = (id: string) =>
      approval.createApprovalLink(
        client,
        { entity_type: "SAMPLE", entity_id: id },
        CS,
      );

    // Tanpa alamat Web: tautan dimatikan (keputusan K).
    const first = await sentSample("Aura Link");
    await expect(link(first)).rejects.toThrow(
      "Set the approval web address in Business settings first.",
    );
    await client.execute(
      "INSERT INTO setting_gex_system (key, value) VALUES ('approval_web_url', 'https://crm.company.id') ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    );
    const old = await link(first);
    const fresh = await link(first);
    expect(fresh.url.startsWith("https://crm.company.id/approve?t=")).toBe(
      true,
    );
    // Tautan baru membatalkan tautan lama (keputusan L).
    expect((await approval.readApproval(client, tokenOf(old.url))).valid).toBe(
      false,
    );
    const view = await approval.readApproval(client, tokenOf(fresh.url));
    expect(view.valid && view.decisions).toEqual([
      "APPROVE",
      "REVISE",
      "REJECT",
    ]);
    expect(view.valid && view.brand_name).toBe("Aura Link");

    await expect(
      approval.respondApproval(client, tokenOf(fresh.url), {
        decision: "REVISE",
        responder_name: "Rina",
        notes: "",
      }),
    ).rejects.toThrow("Tell us what to change.");
    expect(
      await approval.respondApproval(client, tokenOf(fresh.url), {
        decision: "APPROVE",
        responder_name: "Rina",
        notes: "",
      }),
    ).toEqual({ decision: "APPROVE" });
    // Sekali pakai.
    await expect(
      approval.respondApproval(client, tokenOf(fresh.url), {
        decision: "APPROVE",
        responder_name: "Rina",
        notes: "",
      }),
    ).rejects.toThrow("This approval link is not valid or has expired.");

    const detail = await samples.getSampleRequest(client, first, false);
    expect(detail.request.status).toBe("CLIENT_ACC");
    const answered = detail.status_log[0];
    expect([
      answered?.action,
      answered?.recorded_by,
      answered?.on_behalf_of_division,
      answered?.notes,
    ]).toEqual([
      "CLIENT_ACC",
      null,
      "Client",
      "Rina (approval link): Approved",
    ]);
    // Jawaban lewat tautan tidak butuh tangkapan layar.
    const shots = await client.execute({
      sql: "SELECT COUNT(*) AS total FROM media_asset WHERE owner_id = ? AND purpose = 'CLIENT_RESPONSE';",
      args: [first],
    });
    expect(Number(shots.rows[0]?.total)).toBe(0);
    const notified = await client.execute(
      "SELECT COUNT(*) AS total FROM notification_outbox WHERE event_type = 'CLIENT_RESPONDED' AND target_division = 'CS';",
    );
    expect(Number(notified.rows[0]?.total)).toBe(1);

    // Tiket yang tidak sedang menunggu klien tidak bisa dibuatkan tautan.
    await expect(link(first)).rejects.toThrow(
      "The client cannot answer this yet.",
    );

    // Jawaban yang dicatat manual (dengan tangkapan layar) menggugurkan tautan.
    const second = await sentSample("Aura Manual");
    const pending = await link(second);
    await step(second, "CLIENT_REVISE");
    expect(
      (await approval.readApproval(client, tokenOf(pending.url))).valid,
    ).toBe(false);
    const evidence = await client.execute({
      sql: "SELECT COUNT(*) AS total FROM media_asset WHERE owner_id = ? AND purpose = 'CLIENT_RESPONSE';",
      args: [second],
    });
    expect(Number(evidence.rows[0]?.total)).toBe(1);
    await client.execute(
      "UPDATE setting_gex_system SET value = '' WHERE key = 'approval_web_url';",
    );
  });

  test("dokumen legal: terkunci sampai DP lunas, SIG sebelum BPOM, satu baris per jenis", async () => {
    const RND = { id: 3, role: "RnD" };
    const LEGAL = { id: 4, role: "Legal" };
    const owner = await newClient("081200000093");
    const sample = await samples.createSampleRequest(
      client,
      draft(owner.id, { brand_name: "Aura Legal" }),
      CS,
    );
    for (const action of [
      "SUBMIT_TO_RND",
      "RND_ACCEPT",
      "PROCEED",
      "SAMPLE_READY",
    ]) {
      await step(sample.id, action, { lead_time_days: 14 });
    }
    await price(sample.id);
    await step(sample.id, "SAMPLE_SENT");
    await step(sample.id, "CLIENT_ACC");
    const created = await mou.createMou(
      client,
      {
        sample_id: sample.id,
        terms: {
          total_units: 1000,
          unit_price_idr: 1,
          production_lead_time_days: 30,
          regulatory_path: "WITH_BPOM",
          dp_bp: 5000,
          notes: "",
        },
      },
      CS,
      false,
    );
    for (const action of ["SEND_MOU", "MOU_ACCEPT"]) {
      await mou.recordMouStep(
        client,
        { id: created.id, action, notes: action, evidence_base64: EVIDENCE },
        CS,
      );
    }
    const record = (
      document: Record<string, unknown>,
      actor = LEGAL,
      evidence = "",
    ) =>
      legal.recordLegalDocument(
        client,
        { mou_id: created.id, document, evidence_base64: evidence },
        actor,
      );
    const submitted = {
      kind: "BPOM",
      status: "SUBMITTED",
      reference_no: "REG-1",
      bpom_type: "MD",
      submitted_on: "2026-10-01",
    };
    // E-21: terkunci sampai DP Produksi & Legal lunas.
    await expect(
      record({ kind: "SIG", status: "NOT_REQUIRED", notes: "Cosmetic" }, RND),
    ).rejects.toThrow(
      "Waiting for Finance to verify the production & legal down payment.",
    );
    await settle(sample.id, "DP_PRODUCTION_LEGAL", 16_250_000);
    await expect(record(submitted)).rejects.toThrow(
      "Record the SIG nutrition test first.",
    );
    await record(
      { kind: "SIG", status: "NOT_REQUIRED", notes: "Cosmetic" },
      RND,
    );
    await record(submitted);
    // Koreksi selama belum terbit memperbarui baris yang sama.
    await record({ ...submitted, reference_no: "REG-2" });
    await record(
      {
        ...submitted,
        reference_no: "REG-2",
        status: "ISSUED",
        certificate_no: "MD 123",
        issued_on: "2026-11-01",
      },
      LEGAL,
      EVIDENCE,
    );
    await expect(record(submitted)).rejects.toThrow(
      "This document is already final.",
    );
    const rows = await client.execute({
      sql: "SELECT reference_no, certificate_no, status FROM legal_documents WHERE mou_id = ? AND kind = 'BPOM';",
      args: [created.id],
    });
    expect(
      rows.rows.map((row) => [
        row.reference_no,
        row.certificate_no,
        row.status,
      ]),
    ).toEqual([["REG-2", "MD 123", "ISSUED"]]);

    let detail = await samples.getSampleRequest(client, sample.id, false);
    expect(detail.request.legal_open).toBe(2);
    expect(detail.legal_documents.length).toBe(2);
    await record({
      kind: "HKI",
      status: "NOT_REQUIRED",
      notes: "Client brand",
    });
    await record({
      kind: "HALAL",
      status: "ISSUED",
      reference_no: "HL-1",
      submitted_on: "2026-10-02",
      certificate_no: "ID-HALAL-1",
      issued_on: "2026-10-20",
      expires_on: "2030-10-20",
    });
    detail = await samples.getSampleRequest(client, sample.id, false);
    expect(detail.request.legal_open).toBe(0);
    expect(
      detail.status_log
        .map((entry) => String(entry.action))
        .filter((action) => action.startsWith("LEGAL_")),
    ).toEqual([
      "LEGAL_HALAL",
      "LEGAL_HKI",
      "LEGAL_BPOM",
      "LEGAL_BPOM",
      "LEGAL_BPOM",
      "LEGAL_SIG",
    ]);
    const photos = await client.execute({
      sql: "SELECT COUNT(*) AS total FROM media_asset WHERE owner_id = ? AND purpose = 'LEGAL_DOCUMENT';",
      args: [sample.id],
    });
    expect(Number(photos.rows[0]?.total)).toBe(1);
  });

  test("izin dokumen legal untuk role Legal, sekali saja", async () => {
    const granted = await client.execute(
      "SELECT rp.permission_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id WHERE r.role_key = 'legal' AND rp.is_allowed = 1 AND rp.permission_key NOT IN ('home.view', 'dashboard.view', 'sync.view') ORDER BY rp.permission_key;",
    );
    expect(granted.rows.map((row) => String(row.permission_key))).toEqual([
      "clients.view",
      "legal.manage",
      "samples.view",
    ]);
  });
});
