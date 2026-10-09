import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import {
  INVOICE_PERMISSION_SEED_SQL,
  initDatabaseSchema,
} from "@/lib/db-schema";
import * as rules from "@/lib/validations/finance";
import * as sampleRules from "@/lib/validations/sample";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const CS = { id: 7, role: "CS" };
const FINANCE = { id: 1, role: "Finance" };
const TINY_WEBP = "UklGRgwAAABXRUJQVlA4TA==";

const clients = await import("@/lib/server/clients");
const samples = await import("@/lib/server/samples");
const finance = await import("@/lib/server/finance");

let client: Client;
let directory: string;
let categoryId: string;
let channelId: string;
let ownerId: string;
let ppnId: string;
let lebaranId: string;

async function paidSample(extra: Record<string, unknown> = {}) {
  const { id } = await samples.createSampleRequest(
    client,
    {
      client_id: ownerId,
      product_category_option_id: categoryId,
      sample_qty: 2,
      brand_name: "Aura Glow",
      packaging: "Amber dropper 30 ml",
      deadline_at: "2026-10-31",
      ship_to_address: "Jl. Merdeka 1, Bandung",
      is_dummy_required: false,
      is_paid_sample: true,
      special_requests: {},
      ...extra,
    },
    CS,
  );
  return id;
}

async function step(id: string, action: string, extra = {}) {
  const rnd =
    action === "RND_ACCEPT"
      ? { product_class: "NEW" }
      : action === "SAMPLE_READY"
        ? { formula_code: "FRM-FIN", product_knowledge: "Gel" }
        : {};
  return samples.recordSampleStep(
    client,
    { id, action, notes: `Step ${action}`, rnd, ...extra },
    CS,
  );
}

function created(row: Record<string, unknown> | undefined) {
  return String(row?.invoice_number ?? "");
}

async function invoiceRow(id: string) {
  const overview = await finance.getFinanceOverview(client);
  return overview.invoices.find((row) => row.id === id) ?? {};
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "finance-test-"));
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
  ownerId = (
    await clients.registerClient(
      client,
      {
        name: "Aura Cosmetics",
        phone: "081300000001",
        channel_option_id: channelId,
        product_category_option_id: categoryId,
      },
      CS,
    )
  ).id;
  ppnId = (
    await finance.saveFinanceOption(
      client,
      { kind: "TAX", label: "PPN", rate_bp: 1100 },
      ADMIN,
    )
  ).id;
  lebaranId = (
    await finance.saveFinanceOption(
      client,
      { kind: "DISCOUNT", label: "Lebaran", rate_bp: 2000 },
      ADMIN,
    )
  ).id;
});

afterAll(() => {
  client.close();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows: libsql baru melepas berkas database saat proses selesai.
  }
});

describe("tagihan dan uang masuk, jalur Web", () => {
  test("SQL bersama dan seed izin identik dengan Rust", () => {
    const tursoPath = ["desktop", "mobile"]
      .map((dir) =>
        join(import.meta.dir, `../../../src-tauri/src/${dir}/turso.rs`),
      )
      .find(existsSync);
    expect(tursoPath).toBeDefined();
    const tursoRs = readFileSync(tursoPath as string, "utf8");
    for (const sql of INVOICE_PERMISSION_SEED_SQL) {
      expect(tursoRs).toContain(`"${sql}"`);
    }
  });

  test("tagihan: diskon sebelum pajak, tarif disalin, nomor INV dengan tag Web", async () => {
    const id = await paidSample();
    const created = await finance.createInvoice(
      client,
      {
        ref_type: "SAMPLE_FEE",
        sample_request_id: id,
        subtotal_idr: 1_000_000,
        discount_option_id: lebaranId,
        tax_option_ids: [ppnId],
      },
      FINANCE,
    );
    expect(created.invoice_number).toMatch(/^INV-\d{8}-WB01$/);
    expect(created.total_idr).toBe(888_000);
    // Mengubah tarif tidak mengubah tagihan yang sudah ada.
    await finance.saveFinanceOption(
      client,
      { id: ppnId, kind: "DISCOUNT", label: "PPN", rate_bp: 1200 },
      ADMIN,
    );
    expect(await invoiceRow(created.id)).toMatchObject({
      client_id: ownerId,
      discount_idr: 200_000,
      tax_idr: 88_000,
      total_idr: 888_000,
      paid_idr: 0,
      taxes_json: '[{"amount_idr":88000,"label":"PPN","rate_bp":1100}]',
    });
    const options = (await finance.getFinanceOverview(client)).options;
    // `kind` tidak pernah berubah walau dikirim lain.
    expect(options.find((row) => row.id === ppnId)).toMatchObject({
      kind: "TAX",
      rate_bp: 1200,
    });
    await expect(
      finance.createInvoice(
        client,
        {
          ref_type: "SAMPLE_FEE",
          sample_request_id: id,
          subtotal_idr: 100,
        },
        FINANCE,
      ),
    ).rejects.toThrow(rules.INVOICE_DUPLICATE);
    await expect(
      finance.createInvoice(
        client,
        {
          ref_type: "TEST_FEE",
          sample_request_id: id,
          subtotal_idr: 100,
        },
        FINANCE,
      ),
    ).rejects.toThrow("This sample was not requested with testing.");
    await finance.saveFinanceOption(
      client,
      { id: lebaranId, label: "Lebaran", rate_bp: 2000, is_active: false },
      ADMIN,
    );
    await expect(
      finance.createInvoice(
        client,
        {
          ref_type: "OTHER",
          client_id: ownerId,
          subtotal_idr: 100,
          discount_option_id: lebaranId,
        },
        FINANCE,
      ),
    ).rejects.toThrow("Choose an active discount.");
  });

  test("alokasi lunas penuh membuka Payment received; batal dan void dijaga", async () => {
    const id = await paidSample();
    await step(id, "SUBMIT_TO_RND");
    await step(id, "RND_ACCEPT", { lead_time_days: 5 });
    await step(id, "PROCEED");
    const invoice = await finance.createInvoice(
      client,
      { ref_type: "SAMPLE_FEE", sample_request_id: id, subtotal_idr: 500_000 },
      FINANCE,
    );
    await expect(step(id, "PAYMENT_RECEIVED")).rejects.toThrow(
      sampleRules.SAMPLE_FEE_UNPAID,
    );
    const small = await finance.recordIncomingFund(
      client,
      {
        received_on: "2026-10-08",
        amount_idr: 300_000,
        client_id: ownerId,
        description: "BCA transfer",
        proof_base64: TINY_WEBP,
      },
      FINANCE,
    );
    await expect(
      finance.allocateFund(
        client,
        { fund_id: small.id, invoice_id: invoice.id, amount_idr: 300_000 },
        FINANCE,
      ),
    ).rejects.toThrow(
      "The amount must equal the unpaid Rp 500.000 of this invoice (difference -Rp 200.000).",
    );
    await expect(
      finance.allocateFund(
        client,
        { fund_id: small.id, invoice_id: invoice.id, amount_idr: 500_000 },
        FINANCE,
      ),
    ).rejects.toThrow(
      "This incoming payment only has Rp 300.000 left to allocate.",
    );
    // Bukti transfer tersimpan sebagai foto milik uang masuk.
    const proof = await client.execute({
      sql: "SELECT m.owner_type, m.purpose FROM incoming_funds f JOIN media_asset m ON m.id = f.proof_media_id WHERE f.id = ?;",
      args: [small.id],
    });
    expect([
      String(proof.rows[0]?.owner_type),
      String(proof.rows[0]?.purpose),
    ]).toEqual(["fund", "PAYMENT_PROOF"]);
    await expect(
      finance.voidIncomingFund(client, { id: small.id, reason: " " }, FINANCE),
    ).rejects.toThrow(rules.CANCEL_REASON_INVALID);
    await finance.voidIncomingFund(
      client,
      { id: small.id, reason: "Typed the wrong amount" },
      FINANCE,
    );

    const full = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: 600_000 },
      FINANCE,
    );
    await finance.allocateFund(
      client,
      { fund_id: full.id, invoice_id: invoice.id, amount_idr: 500_000 },
      FINANCE,
    );
    expect(await invoiceRow(invoice.id)).toMatchObject({ paid_idr: 500_000 });
    await expect(
      finance.allocateFund(
        client,
        { fund_id: full.id, invoice_id: invoice.id, amount_idr: 100_000 },
        FINANCE,
      ),
    ).rejects.toThrow("This invoice is already paid.");
    await expect(
      finance.cancelInvoice(
        client,
        { id: invoice.id, reason: "Wrong client" },
        FINANCE,
      ),
    ).rejects.toThrow("Only an open invoice with no payment can be cancelled.");
    await expect(
      finance.voidIncomingFund(client, { id: full.id, reason: "x" }, FINANCE),
    ).rejects.toThrow(
      "Only an incoming payment with nothing allocated can be voided.",
    );
    expect(await step(id, "PAYMENT_RECEIVED")).toMatchObject({
      status: "IN_RND",
    });
  });

  test("tiket with testing: Sample sent menunggu tagihan uji lunas", async () => {
    const id = await paidSample({
      is_paid_sample: false,
      is_test_requested: true,
    });
    await step(id, "SUBMIT_TO_RND");
    await step(id, "RND_ACCEPT", { lead_time_days: 5 });
    await step(id, "PROCEED");
    await step(id, "SAMPLE_READY");
    await samples.recordSamplePrice(
      client,
      {
        id,
        price: {
          raw_material_cost_idr: 1000,
          packaging_cost_idr: 0,
          operational_cost_idr: 0,
          regulatory_cost_idr: 0,
          margin_bp: 0,
          notes: "",
        },
      },
      FINANCE,
    );
    await expect(step(id, "SAMPLE_SENT")).rejects.toThrow(
      sampleRules.SAMPLE_TEST_UNPAID,
    );
    const invoice = await finance.createInvoice(
      client,
      { ref_type: "TEST_FEE", sample_request_id: id, subtotal_idr: 1_500_000 },
      FINANCE,
    );
    const fund = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: 1_500_000 },
      FINANCE,
    );
    await finance.allocateFund(
      client,
      { fund_id: fund.id, invoice_id: invoice.id, amount_idr: 1_500_000 },
      FINANCE,
    );
    expect(await step(id, "SAMPLE_SENT")).toMatchObject({
      status: "SAMPLE_SENT",
    });
    const detail = await samples.getSampleRequest(client, id, false);
    expect(detail.invoices.map((row) => row.ref_type)).toEqual(["TEST_FEE"]);
  });

  test("pembayaran sebagian menjadi cicilan; gerbang tiket menganggapnya selesai", async () => {
    const plan = await finance.saveFinanceOption(
      client,
      {
        kind: "INSTALLMENT_PLAN",
        label: "3 months",
        rate_bp: 1000,
        installment_count: 3,
      },
      ADMIN,
    );
    const id = await paidSample();
    await step(id, "SUBMIT_TO_RND");
    await step(id, "RND_ACCEPT", { lead_time_days: 5 });
    await step(id, "PROCEED");
    const invoice = await finance.createInvoice(
      client,
      {
        ref_type: "SAMPLE_FEE",
        sample_request_id: id,
        subtotal_idr: 5_000_000,
      },
      FINANCE,
    );
    const fund = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: 2_000_000, client_id: ownerId },
      FINANCE,
    );
    await expect(
      finance.acceptPartialPayment(
        client,
        {
          fund_id: fund.id,
          invoice_id: invoice.id,
          amount_idr: 2_000_000,
          plan_option_id: lebaranId,
        },
        FINANCE,
      ),
    ).rejects.toThrow("Choose an active installment plan.");
    expect(
      await finance.acceptPartialPayment(
        client,
        {
          fund_id: fund.id,
          invoice_id: invoice.id,
          amount_idr: 2_000_000,
          plan_option_id: plan.id,
        },
        FINANCE,
      ),
    ).toMatchObject({ installments: 3, total_idr: 3_300_000 });
    const overview = await finance.getFinanceOverview(client);
    const parent = overview.invoices.find((row) => row.id === invoice.id);
    expect(parent).toMatchObject({
      status: "RESCHEDULED",
      paid_idr: 2_000_000,
    });
    const children = overview.invoices
      .filter((row) => row.parent_invoice_id === invoice.id)
      .sort((a, b) => Number(a.installment_no) - Number(b.installment_no));
    expect(
      children.map((row) => [
        row.invoice_number,
        row.ref_type,
        row.total_idr,
        row.status,
      ]),
    ).toEqual([
      [`${created(parent)}-1`, "INSTALLMENT", 1_100_000, "OPEN"],
      [`${created(parent)}-2`, "INSTALLMENT", 1_100_000, "OPEN"],
      [`${created(parent)}-3`, "INSTALLMENT", 1_100_000, "OPEN"],
    ]);
    // Tagihan asal yang dijadwal ulang tidak menerima alokasi lagi, dan
    // cicilan tidak bisa dijadwal ulang lagi (keputusan H).
    const more = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: 500_000, client_id: ownerId },
      FINANCE,
    );
    await expect(
      finance.allocateFund(
        client,
        { fund_id: more.id, invoice_id: invoice.id, amount_idr: 1 },
        FINANCE,
      ),
    ).rejects.toThrow("This invoice is cancelled or does not exist.");
    await expect(
      finance.acceptPartialPayment(
        client,
        {
          fund_id: more.id,
          invoice_id: String(children[0]?.id),
          amount_idr: 100_000,
          plan_option_id: plan.id,
        },
        FINANCE,
      ),
    ).rejects.toThrow("An installment cannot be rescheduled again.");
    // Keputusan G: tagihan yang dijadwal ulang membuka Payment received.
    expect(await step(id, "PAYMENT_RECEIVED")).toMatchObject({
      status: "IN_RND",
    });

    // Lebih bayar menjadi deposit klien (keputusan I).
    await finance.confirmDeposit(client, { fund_id: more.id }, FINANCE);
    await expect(
      finance.confirmDeposit(client, { fund_id: more.id }, FINANCE),
    ).rejects.toThrow("This payment is already kept as a deposit.");
    const unknown = await finance.recordIncomingFund(
      client,
      { received_on: "2026-10-08", amount_idr: 10_000 },
      FINANCE,
    );
    await expect(
      finance.confirmDeposit(client, { fund_id: unknown.id }, FINANCE),
    ).rejects.toThrow("Choose the client this deposit belongs to.");
    await finance.confirmDeposit(
      client,
      { fund_id: unknown.id, client_id: ownerId },
      FINANCE,
    );
    const funds = (await finance.getFinanceOverview(client)).funds;
    expect(funds.find((row) => row.id === unknown.id)).toMatchObject({
      client_id: ownerId,
      deposit_confirmed_by: 1,
    });
  });

  test("izin: invoices.view untuk CS dan Finance; pajak/diskon tidak ikut Admin", async () => {
    const viewers = await client.execute(
      `SELECT r.role_key FROM app_role r JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE rp.permission_key = 'invoices.view' AND r.role_key IN ('cs', 'finance', 'rnd') ORDER BY r.role_key;`,
    );
    expect(viewers.rows.map((row) => String(row.role_key))).toEqual([
      "cs",
      "finance",
    ]);
    const admin = await client.execute(
      "SELECT COUNT(*) AS total FROM role_permission WHERE role_id = 2 AND permission_key = 'finance_options.manage';",
    );
    expect(Number(admin.rows[0]?.total)).toBe(0);
  });
});
