import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const actor = (id: number) => ({ id, role: "CS" });

const clients = await import("@/lib/server/clients");
const leads = await import("@/lib/server/leads");

let client: Client;
let directory: string;
let leadId: string;

function operator(
  id: number,
  permissions: string[] = ["leads.view", "leads.manage"],
): OperatorUser {
  return {
    id,
    kode_operator: `OP${id}`,
    nama_operator: `Operator ${id}`,
    username: `op${id}`,
    role: "Operator",
    roleId: 3,
    roleKey: "operator",
    isSuperadmin: false,
    permissions: permissions as OperatorUser["permissions"],
    permissionRevision: 1,
  };
}

async function leadRow() {
  const result = await client.execute({
    sql: "SELECT last_followup_at, last_client_response_at, total_followups, pic_cs_id FROM leads WHERE id = ?;",
    args: [leadId],
  });
  return result.rows[0];
}

beforeAll(async () => {
  // Berkas sementara, bukan `file::memory:`: `transaction()` membuka koneksi
  // baru, dan koneksi baru ke database memori berarti database kosong.
  directory = mkdtempSync(join(tmpdir(), "leads-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (7, 'OP7', 'Rina CS', 'rina', 'x', 'Active'),
            (8, 'OP8', 'Budi CS', 'budi', 'x', 'Active'),
            (9, 'OP9', 'Lama', 'lama', 'x', 'Inactive');`,
  );
});

beforeEach(async () => {
  await client.execute("DELETE FROM lead_interactions;");
  await client.execute("DELETE FROM leads;");
  await client.execute("DELETE FROM clients;");
  await client.execute("DELETE FROM master_option;");
  const channel = await clients.saveMasterOption(
    client,
    {
      kind: "LEAD_CHANNEL",
      code: "IG",
      label: "Instagram",
    },
    ADMIN,
  );
  const category = await clients.saveMasterOption(
    client,
    {
      kind: "PRODUCT_CATEGORY",
      code: "SKIN",
      label: "Skincare",
    },
    ADMIN,
  );
  await clients.registerClient(
    client,
    {
      name: "Rina Beauty",
      phone: "081234567890",
      channel_option_id: channel.id,
      product_category_option_id: category.id,
    },
    actor(7),
  );
  const [row] = await clients.listClients(client);
  leadId = row?.lead_id ?? "";
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("interaksi lead, jalur Web", () => {
  test("SQL ringkasan identik dengan konstanta Rust", () => {
    // Salinan Mobile membaca `mobile/clients.rs`, Web-Desktop `desktop/clients.rs`.
    const rustPath = ["desktop", "mobile"]
      .map((dir) =>
        join(import.meta.dir, `../../../src-tauri/src/${dir}/clients.rs`),
      )
      .find(existsSync);
    expect(rustPath).toBeDefined();
    const rust = readFileSync(rustPath as string, "utf8");
    expect(rust).toContain(`"${leads.LEAD_SUMMARY_UPDATE_SQL}"`);
    expect(rust).toContain(`"${leads.LEAD_INTERACTION_INSERT_SQL}"`);
  });

  test("lead baru langsung HOT dengan nama PIC", async () => {
    const [row] = await clients.listClients(client);
    expect(row).toMatchObject({
      segment: "HOT",
      days_since_response: 0,
      pic_cs_id: 7,
      pic_cs_name: "Rina CS",
      total_followups: 0,
      last_followup_at: "",
    });
  });

  test("follow up menambah Jumlah FU, respons klien memajukan tanggal respons", async () => {
    const now = Math.floor(Date.now() / 1000);
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: leadId,
        direction: "OUTBOUND",
        kind: "WHATSAPP",
        notes: "Kirim katalog",
        occurred_at: now - 7200,
      },
      operator(7),
    );
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: leadId,
        direction: "OUTBOUND",
        kind: "CALL",
        notes: "Telepon ulang",
        occurred_at: now - 3600,
      },
      operator(7),
    );
    const before = await leadRow();
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: leadId,
        direction: "INBOUND",
        kind: "WHATSAPP",
        notes: "Klien minta harga",
      },
      operator(7),
    );
    const after = await leadRow();
    expect(Number(after?.total_followups)).toBe(2);
    expect(String(after?.last_followup_at)).toBe(
      String(before?.last_followup_at),
    );
    expect(
      String(after?.last_client_response_at) >=
        String(before?.last_client_response_at),
    ).toBe(true);

    const history = await leads.listLeadInteractions(client, leadId);
    expect(history.map((item) => item.notes)).toEqual([
      "Klien minta harga",
      "Telepon ulang",
      "Kirim katalog",
    ]);
    expect(history[0]?.operator_name).toBe("Rina CS");
  });

  test("interaksi yang tercatat mundur tidak memundurkan tanggal", async () => {
    const now = Math.floor(Date.now() / 1000);
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: leadId,
        direction: "OUTBOUND",
        kind: "CALL",
        notes: "Baru",
        occurred_at: now - 60,
      },
      operator(7),
    );
    const latest = String((await leadRow())?.last_followup_at);
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: leadId,
        direction: "OUTBOUND",
        kind: "CALL",
        notes: "Lama, dicatat belakangan",
        occurred_at: now - 86_400,
      },
      operator(7),
    );
    const row = await leadRow();
    expect(String(row?.last_followup_at)).toBe(latest);
    expect(Number(row?.total_followups)).toBe(2);
  });

  test("kiriman ulang interaksi yang sama tidak menghitung ganda", async () => {
    const args = ["OUTBOUND", "2026-09-24 10:00:00", leadId, "retry-1"];
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.execute({ sql: leads.LEAD_SUMMARY_UPDATE_SQL, args });
      await client.execute({
        sql: leads.LEAD_INTERACTION_INSERT_SQL,
        args: [
          "retry-1",
          leadId,
          7,
          "OUTBOUND",
          "CALL",
          "Push terkirim dua kali",
          "2026-09-24 10:00:00",
          "2026-09-24 10:00:00",
        ],
      });
    }
    expect(Number((await leadRow())?.total_followups)).toBe(1);
  });

  test("hanya PIC yang boleh mencatat, kecuali pemegang leads.reassign", async () => {
    const draft = {
      lead_id: leadId,
      direction: "OUTBOUND",
      kind: "CALL",
      notes: "Bantu follow up",
    };
    await expect(
      leads.recordLeadInteraction(client, draft, operator(8)),
    ).rejects.toThrow(
      "Only the lead's CS can record on it. Ask an Admin to reassign the lead.",
    );
    await leads.recordLeadInteraction(
      client,
      draft,
      operator(8, ["leads.view", "leads.manage", "leads.reassign"]),
    );
    expect(Number((await leadRow())?.total_followups)).toBe(1);
  });

  test("masukan tidak sah ditolak dengan pesan yang sama seperti Rust", async () => {
    const base = {
      lead_id: leadId,
      direction: "OUTBOUND",
      kind: "CALL",
      notes: "Catatan",
    };
    await expect(
      leads.recordLeadInteraction(
        client,
        { ...base, direction: "SIDEWAYS" },
        operator(7),
      ),
    ).rejects.toThrow(
      "Choose whether this is a follow up or a client response.",
    );
    await expect(
      leads.recordLeadInteraction(
        client,
        { ...base, kind: "FAX" },
        operator(7),
      ),
    ).rejects.toThrow("Choose how the contact happened.");
    await expect(
      leads.recordLeadInteraction(
        client,
        { ...base, notes: "  " },
        operator(7),
      ),
    ).rejects.toThrow("Notes are required, up to 1000 characters.");
    await expect(
      leads.recordLeadInteraction(
        client,
        { ...base, occurred_at: Math.floor(Date.now() / 1000) + 3600 },
        operator(7),
      ),
    ).rejects.toThrow("The interaction time cannot be in the future.");
    expect(await leads.listLeadInteractions(client, leadId)).toHaveLength(0);
  });

  test("pindah PIC hanya ke operator aktif", async () => {
    await leads.reassignLead(client, leadId, 8, ADMIN);
    expect(Number((await leadRow())?.pic_cs_id)).toBe(8);
    await expect(leads.reassignLead(client, leadId, 9, ADMIN)).rejects.toThrow(
      "Choose an active operator.",
    );
    const directory = await leads.listOperatorDirectory(client);
    expect(directory.map((entry) => entry.nama_operator)).toEqual([
      "Budi CS",
      "Rina CS",
    ]);
  });

  test("respons lebih dari 7 hari lalu masuk COLD", async () => {
    await client.execute({
      sql: "UPDATE leads SET last_client_response_at = datetime('now', '-8 days') WHERE id = ?;",
      args: [leadId],
    });
    const [row] = await clients.listClients(client);
    expect(row?.segment).toBe("COLD");
    expect(row?.days_since_response).toBeGreaterThanOrEqual(8);
  });
});
