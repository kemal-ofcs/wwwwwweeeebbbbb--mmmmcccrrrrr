import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import {
  bootstrapSuperadmin,
  insertOperator,
  removeOperator,
} from "@/lib/operators/operator-admin";

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

afterAll(() => client.close());

describe("superadmin bootstrap", () => {
  test("membuat satu Superadmin dan menutup bootstrap berikutnya", async () => {
    const result = await bootstrapSuperadmin(client, {
      kodeOperator: "SPD001",
      name: "Pemilik Aplikasi",
      username: "pemilik",
      email: "pemilik@contoh.id",
      noHp: "081200000001",
      password: "BootstrapKuat123",
      status: "Active",
    });
    expect(result.id).toBeGreaterThan(0);

    const record = await client.execute(`
      SELECT m.kode_operator, r.role_key
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ${result.id};
    `);
    expect(record.rows[0]).toMatchObject({
      kode_operator: "SPD001",
      role_key: "superadmin",
    });

    await expect(
      bootstrapSuperadmin(client, {
        kodeOperator: "SPD001",
        name: "Pemilik Kedua",
        username: "pemilik-kedua",
        email: "pemilik-kedua@contoh.id",
        noHp: "081200000002",
        password: "BootstrapKedua456",
        status: "Active",
      }),
    ).rejects.toThrow("an active Superadmin already exists");
  });
});

describe("hapus operator", () => {
  // Dulu setiap penghapusan gagal "no such table: log_scan": daftar referensi
  // menghitung tabel milik proyek asal yang tidak pernah ada di skema ini.
  test("operator tanpa histori bisa dihapus", async () => {
    const role = await client.execute(
      "SELECT id FROM app_role WHERE is_superadmin = 0 ORDER BY id LIMIT 1;",
    );
    const superadmin = await client.execute(
      "SELECT id FROM master_operator WHERE kode_operator = 'SPD001';",
    );
    const { id } = await insertOperator(client, {
      kodeOperator: "OPR900",
      name: "Operator Sementara",
      username: "operator-sementara",
      email: "sementara@contoh.id",
      noHp: "081200000009",
      password: "SementaraKuat123",
      roleId: Number(role.rows[0]?.id),
      status: "Active",
    });

    await removeOperator(client, Number(superadmin.rows[0]?.id), id);

    const sisa = await client.execute({
      sql: "SELECT COUNT(*) AS total FROM master_operator WHERE id = ?;",
      args: [id],
    });
    expect(Number(sisa.rows[0]?.total)).toBe(0);
  });
});
