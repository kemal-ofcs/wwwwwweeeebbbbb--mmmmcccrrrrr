import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { DIVISION_ROLE_SEED_SQL, initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const CS = { id: 7, role: "CS" };

const audit = await import("@/lib/server/audit");
const clients = await import("@/lib/server/clients");
const leads = await import("@/lib/server/leads");

let client: Client;
let directory: string;

/** Salinan Mobile membaca `mobile/...`, Web-Desktop `desktop/...`. */
function rustSource(file: string) {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/${file}`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  return readFileSync(path as string, "utf8");
}

async function auditRows() {
  const result = await client.execute(
    "SELECT action, entity_type, entity_id, actor_operator_id, on_behalf_of_division FROM domain_audit_log ORDER BY rowid;",
  );
  return result.rows.map((row) => ({ ...row }));
}

beforeAll(async () => {
  // Berkas sementara: `transaction()` membuka koneksi baru, dan koneksi baru ke
  // `file::memory:` berarti database kosong.
  directory = mkdtempSync(join(tmpdir(), "audit-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active'),
            (7, 'OP7', 'Rina CS', 'rina', 'x', 'Active');`,
  );
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("log audit, jalur Web", () => {
  test("SQL audit dan seed role divisi identik dengan Rust", () => {
    const clientsRs = rustSource("clients.rs");
    expect(clientsRs).toContain(`"${audit.DOMAIN_AUDIT_INSERT_SQL}"`);
    expect(clientsRs).toContain(`"${audit.DOMAIN_AUDIT_LIST_SQL}"`);
    const tursoRs = rustSource("turso.rs");
    for (const sql of DIVISION_ROLE_SEED_SQL) {
      expect(tursoRs).toContain(`"${sql}"`);
    }
  });

  test("satu mutasi menghasilkan tepat satu baris audit", async () => {
    const channel = await clients.saveMasterOption(
      client,
      { kind: "LEAD_CHANNEL", code: "IG", label: "Instagram" },
      ADMIN,
    );
    const category = await clients.saveMasterOption(
      client,
      { kind: "PRODUCT_CATEGORY", code: "SKIN", label: "Skincare" },
      ADMIN,
    );
    const saved = await clients.registerClient(
      client,
      {
        name: "Rina Beauty",
        phone: "081234567890",
        channel_option_id: channel.id,
        product_category_option_id: category.id,
      },
      CS,
    );
    const before = (await auditRows()).length;
    const [row] = await clients.listClients(client);
    await leads.recordLeadInteraction(
      client,
      {
        lead_id: row?.lead_id,
        direction: "OUTBOUND",
        kind: "CALL",
        notes: "Telepon pertama",
      },
      { ...CS, permissions: ["leads.view", "leads.manage"] } as never,
    );
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: "lead_interaction.record",
      entity_type: "lead",
      entity_id: row?.lead_id,
      actor_operator_id: 7,
      on_behalf_of_division: "CS",
    });
    expect(rows.map((item) => item.action)).toEqual([
      "master_option.save",
      "master_option.save",
      "client.register",
      "lead_interaction.record",
    ]);
    expect(rows[2]?.entity_id).toBe(saved.id);
  });

  test("mutasi yang ditolak tidak meninggalkan baris audit", async () => {
    const before = (await auditRows()).length;
    await expect(
      clients.saveMasterOption(
        client,
        { kind: "LEAD_CHANNEL", code: "IG", label: "Duplikat" },
        ADMIN,
      ),
    ).rejects.toThrow("Another option of this type already uses that code.");
    expect(await auditRows()).toHaveLength(before);
  });

  test("filter jenis entitas, pelaku, dan tanggal", async () => {
    const all = await audit.listDomainAudit(client, {});
    expect(all[0]?.actor_name).toBe("Rina CS");
    const byEntity = await audit.listDomainAudit(client, {
      entity_type: "master_option",
    });
    expect(byEntity.map((item) => item.action)).toEqual([
      "master_option.save",
      "master_option.save",
    ]);
    const byActor = await audit.listDomainAudit(client, {
      actor_operator_id: 7,
    });
    expect(byActor.every((item) => item.actor_operator_id === 7)).toBe(true);
    expect(
      await audit.listDomainAudit(client, {
        from: "2000-01-01",
        to: "2000-01-02",
      }),
    ).toHaveLength(0);
  });
});

describe("role divisi", () => {
  test("sepuluh role divisi dengan paket izinnya", async () => {
    const roles = await client.execute(
      "SELECT role_key FROM app_role WHERE is_system = 0 ORDER BY id;",
    );
    expect(roles.rows.map((row) => String(row.role_key))).toEqual([
      "cs",
      "crm",
      "rnd",
      "finance",
      "design",
      "legal",
      "ppic",
      "production_spv",
      "qc",
      "logistics",
    ]);
    const packages = await client.execute(
      `SELECT r.role_key, group_concat(rp.permission_key) AS keys
       FROM app_role r JOIN role_permission rp ON rp.role_id = r.id AND rp.is_allowed = 1
       WHERE r.role_key IN ('cs', 'crm', 'qc') GROUP BY r.role_key ORDER BY r.role_key;`,
    );
    const byRole = Object.fromEntries(
      packages.rows.map((row) => [
        String(row.role_key),
        String(row.keys).split(",").sort(),
      ]),
    );
    expect(byRole.cs).toEqual([
      "clients.manage",
      "clients.view",
      "dashboard.view",
      "home.view",
      "leads.manage",
      "leads.view",
      "sync.view",
    ]);
    expect(byRole.crm).toEqual([
      "clients.view",
      "dashboard.view",
      "home.view",
      "leads.view",
      "sync.view",
    ]);
    expect(byRole.qc).toEqual(["dashboard.view", "home.view", "sync.view"]);
  });

  test("role yang dihapus dan izin yang dicabut tidak kembali saat skema diinisialisasi ulang", async () => {
    await client.execute("DELETE FROM app_role WHERE role_key = 'qc';");
    await client.execute(
      "DELETE FROM role_permission WHERE role_id = (SELECT id FROM app_role WHERE role_key = 'crm') AND permission_key = 'leads.view';",
    );
    // Paksa jalur inisialisasi penuh seperti saat skema naik versi.
    await client.execute("DELETE FROM schema_migration WHERE version = 5;");
    await initDatabaseSchema(client);
    const qc = await client.execute(
      "SELECT COUNT(*) AS total FROM app_role WHERE role_key = 'qc';",
    );
    expect(Number(qc.rows[0]?.total)).toBe(0);
    const crm = await client.execute(
      "SELECT COUNT(*) AS total FROM role_permission WHERE role_id = (SELECT id FROM app_role WHERE role_key = 'crm') AND permission_key = 'leads.view';",
    );
    expect(Number(crm.rows[0]?.total)).toBe(0);
  });
});
