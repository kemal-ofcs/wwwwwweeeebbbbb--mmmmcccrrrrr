import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };

const clients = await import("@/lib/server/clients");
const sheets = await import("@/lib/server/sheet-import");

let client: Client;
let directory: string;
let clientId: string;
let clientCode: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sheet-import-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active');`,
  );
  const option = async (kind: string, code: string) =>
    (await clients.saveMasterOption(client, { kind, code, label: code }, ADMIN))
      .id;
  const created = await clients.registerClient(
    client,
    {
      name: "Aura Cosmetics",
      phone: "081300000001",
      channel_option_id: await option("LEAD_CHANNEL", "IG"),
      product_category_option_id: await option("PRODUCT_CATEGORY", "SKIN"),
    },
    ADMIN,
  );
  clientId = created.id;
  const row = await client.execute({
    sql: "SELECT client_code FROM clients WHERE id = ?;",
    args: [clientId],
  });
  clientCode = String(row.rows[0]?.client_code);
});

afterAll(() => {
  client.close();
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows: libsql baru melepas berkasnya saat proses selesai (EBUSY).
  }
});

const row = (line: number, values: Record<string, string>) => ({
  line,
  date: "",
  client_code: "",
  code: "",
  title: "",
  amount: "",
  notes: "",
  ...values,
});

test("uang masuk: pratinjau = simpan, impor ulang menambah nol", async () => {
  const body = {
    kind: "FUNDS",
    file_name: "uang-masuk.csv",
    date_order: "DMY",
    rows: [
      row(2, { date: "5/10/2026", amount: "Rp 2.000.000", notes: "BCA" }),
      row(3, {
        date: "6/10/2026",
        amount: "500.000",
        client_code: clientCode.toLowerCase(),
      }),
      row(4, { date: "6/10/2026", amount: "1,50" }),
    ],
  };
  const preview = await sheets.importSheet(client, body, ADMIN);
  expect([preview.added, preview.invalid, preview.dry_run]).toEqual([
    2,
    1,
    true,
  ]);
  const saved = await sheets.importSheet(
    client,
    { ...body, dry_run: false },
    ADMIN,
  );
  expect(saved.added).toBe(2);
  const funds = await client.execute(
    "SELECT received_on, amount_idr, client_id, status FROM incoming_funds ORDER BY received_on;",
  );
  expect(
    funds.rows.map((fund) => [
      fund.received_on,
      fund.amount_idr,
      fund.client_id,
      fund.status,
    ]),
  ).toEqual([
    ["2026-10-05", 2_000_000, "", "ACTIVE"],
    ["2026-10-06", 500_000, clientId, "ACTIVE"],
  ]);
  const again = await sheets.importSheet(
    client,
    { ...body, dry_run: false },
    ADMIN,
  );
  expect([again.added, again.skipped]).toEqual([0, 2]);
  const audit = await client.execute(
    "SELECT COUNT(*) AS total FROM domain_audit_log WHERE action = 'sheet.import';",
  );
  expect(Number(audit.rows[0]?.total)).toBe(1);
});

test("arsip formulasi: klien wajib, tampil di detail klien", async () => {
  const body = {
    kind: "FORMULA",
    file_name: "formulasi.csv",
    date_order: "DMY",
    dry_run: false,
    rows: [
      row(2, {
        client_code: clientCode,
        code: "F-01",
        title: "Brightening serum",
        amount: "32.500",
        date: "1/9/2026",
      }),
      row(3, { client_code: "KP-404", title: "Toner" }),
      row(4, { title: "Toner" }),
    ],
  };
  const saved = await sheets.importSheet(client, body, ADMIN);
  expect([saved.added, saved.invalid]).toEqual([1, 2]);
  expect(saved.results.map((result) => result.message)).toEqual([
    "Kode Klien KP-404 is not registered.",
    "Kode Klien is empty.",
  ]);
  const records = await sheets.listImportedRecords(client, clientId);
  expect(
    records.map((record) => [
      record.kind,
      record.code,
      record.title,
      record.amount_idr,
      record.record_date,
      record.source_file,
    ]),
  ).toEqual([
    [
      "FORMULA",
      "F-01",
      "Brightening serum",
      32_500,
      "2026-09-01",
      "formulasi.csv",
    ],
  ]);
  const again = await sheets.importSheet(client, body, ADMIN);
  expect([again.added, again.skipped]).toEqual([0, 1]);
  await expect(
    sheets.importSheet(client, { ...body, kind: "CLIENTS" }, ADMIN),
  ).rejects.toThrow("Choose which sheet to import.");
});
