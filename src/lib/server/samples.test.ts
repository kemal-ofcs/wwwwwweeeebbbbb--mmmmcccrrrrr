import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import {
  initDatabaseSchema,
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

async function step(id: string, action: string, extra = {}) {
  return samples.recordSampleStep(
    client,
    { id, action, notes: `Step ${action}`, ...extra },
    CS,
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
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
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
    ]) {
      expect(samplesRs).toContain(`"${sql}"`);
    }
    expect(samplesRs).toContain(`"${rules.SAMPLE_CHANGED_ELSEWHERE}"`);
    const tursoRs = rustSource("turso.rs");
    for (const sql of SAMPLE_PERMISSION_SEED_SQL) {
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
    await step(id, "SAMPLE_SENT");
    expect(await step(id, "CLIENT_REVISE")).toEqual({
      status: "IN_RND",
      revision_index: 1,
    });
    await step(id, "SAMPLE_READY");
    await step(id, "SAMPLE_SENT");
    expect(await step(id, "CLIENT_REVISE")).toEqual({
      status: "PENDING_FEE_ASSESSMENT",
      revision_index: 2,
    });
    await expect(step(id, "PAYMENT_RECEIVED")).rejects.toThrow(
      rules.SAMPLE_STEP_NOT_ALLOWED,
    );

    const detail = await samples.getSampleRequest(client, id);
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
    const { request } = await samples.getSampleRequest(client, id);
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
