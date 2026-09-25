import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import * as sql from "@/lib/auth/session-sql";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const store = await import("@/lib/auth/session-store");
const sessions = await import("@/lib/server/sessions");

const ADMIN = { id: 1, role: "Admin" };
const OPERATOR = {
  id: 7,
  kode_operator: "OP7",
  nama_operator: "Rina CS",
  username: "rina",
  role: "CS",
  roleId: 2,
  roleKey: "cs",
  isSuperadmin: false,
  permissions: [],
  permissionRevision: 1,
};

let client: Client;
let directory: string;

function rustSource(file: string) {
  const path = ["desktop", "mobile"]
    .map((dir) =>
      join(import.meta.dir, `../../../src-tauri/src/${dir}/${file}`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  return readFileSync(path as string, "utf8");
}

/** Sesi perangkat seperti yang ditulis `open_device_session` di Rust. */
async function deviceSession(
  id: string,
  operatorId: number,
  createdAt: string,
) {
  await client.execute({
    sql: `INSERT INTO app_session (session_id, token_hash, operator_id, permission_revision, created_at, expires_at, last_seen_at, client_kind, device_label)
          VALUES (?, ?, ?, 1, ?, '9999-12-31 23:59:59', ?, 'desktop', 'windows abc');`,
    args: [id, `device:${id}`, operatorId, createdAt, createdAt],
  });
}

async function revoked(id: string) {
  const result = await client.execute({
    sql: "SELECT revoked_at, revoked_reason FROM app_session WHERE session_id = ?;",
    args: [id],
  });
  return result.rows[0];
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessions-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    `INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status)
     VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active'),
            (7, 'OP7', 'Rina CS', 'rina', 'x', 'Active'),
            (9, 'OP9', 'Budi CS', 'budi', 'x', 'Active');`,
  );
  // `readSessionRecord` hanya menerima operator dengan role aktif.
  await client.execute(
    "UPDATE master_operator SET role_id = (SELECT id FROM app_role WHERE role_key = 'cs') WHERE id = 7;",
  );
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("sesi tunggal", () => {
  test("SQL sesi identik dengan Rust", () => {
    const clientsRs = rustSource("clients.rs");
    for (const value of Object.values(sql)) {
      expect(clientsRs).toContain(`"${value}"`);
    }
  });

  test("login Web mencabut sesi lain operator yang sama, tidak milik operator lain", async () => {
    await deviceSession("laptop-7", 7, "2026-09-25 01:00:00");
    await deviceSession("laptop-9", 9, "2026-09-25 01:00:00");
    const created = await store.createSessionRecord(
      client,
      OPERATOR as never,
      "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36",
    );
    expect(await revoked("laptop-7")).toMatchObject({
      revoked_reason: "SUPERSEDED",
    });
    expect((await revoked("laptop-9"))?.revoked_at).toBeNull();
    const active = await sessions.listActiveSessions(client);
    const mine = active.filter((row) => row.operator_id === 7);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      client_kind: "web",
      device_label: "Chrome on Windows",
    });
    // Cookie sesi yang dicabut melaporkan alasannya ke layar login.
    expect(await store.readSessionRecord(client, created.token)).not.toBeNull();
    await store.createSessionRecord(client, OPERATOR as never, null);
    expect(await store.readSessionRecord(client, created.token)).toBeNull();
    expect(await store.readSessionEndReason(client, created.token)).toBe(
      "SUPERSEDED",
    );
  });

  test("logout biasa tidak dilaporkan sebagai sesi yang diakhiri", async () => {
    const created = await store.createSessionRecord(client, OPERATOR as never);
    await store.revokeSessionRecord(client, created.token);
    expect(await store.readSessionEndReason(client, created.token)).toBeNull();
  });

  test("sesi dicabut disimpan 30 hari, bentuk ISO maupun datetime", async () => {
    await client.execute(
      `INSERT INTO app_session (session_id, token_hash, operator_id, permission_revision, created_at, expires_at, last_seen_at, revoked_at, revoked_reason)
       VALUES ('lama-iso', 'h1', 9, 1, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', 'logout'),
              ('lama-dt', 'h2', 9, 1, '2000-01-01 00:00:00', '9999-12-31 23:59:59', '2000-01-01 00:00:00', '2000-01-02 00:00:00', 'SUPERSEDED'),
              ('baru', 'h3', 9, 1, datetime('now', '-2 days'), '9999-12-31 23:59:59', datetime('now'), datetime('now', '-1 days'), 'SUPERSEDED'),
              ('kedaluwarsa', 'h4', 9, 1, '2000-01-01T00:00:00.000Z', '2000-01-08T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL, NULL);`,
    );
    await client.execute(sql.SESSION_PURGE_SQL);
    const left = await client.execute(
      "SELECT session_id FROM app_session WHERE session_id IN ('lama-iso', 'lama-dt', 'baru', 'kedaluwarsa') ORDER BY session_id;",
    );
    expect(left.rows.map((row) => String(row.session_id))).toEqual(["baru"]);
  });

  test("sesi offline tersusul hanya oleh sesi yang lahir setelah kontak terakhir", async () => {
    await client.execute("DELETE FROM app_session WHERE operator_id = 9;");
    // Lahir sebelum kontak (bentuk ISO, ditulis Web) dan sudah dicabut.
    await client.execute(
      `INSERT INTO app_session (session_id, token_hash, operator_id, permission_revision, created_at, expires_at, last_seen_at, revoked_at, revoked_reason)
       VALUES ('web-lama', 'w1', 9, 1, '2026-09-25T08:00:00.000Z', '2999-01-01T00:00:00.000Z', '2026-09-25T08:00:00.000Z', '2026-09-25T09:00:00.000Z', 'logout');`,
    );
    const superseded = async (contact: string | null) => {
      const result = await client.execute({
        sql: sql.OFFLINE_SESSION_SUPERSEDED_SQL,
        args: [9, contact],
      });
      return Number(result.rows[0]?.total) > 0;
    };
    // Teks "2026-09-25T08..." > "2026-09-25 08..." secara leksikal; julianday
    // yang membuat keduanya sebanding.
    expect(await superseded("2026-09-25 08:30:00")).toBe(false);
    expect(await superseded("2026-09-25 07:59:59")).toBe(true);
    // Tanpa catatan kontak: hanya sesi aktif yang dihitung.
    expect(await superseded(null)).toBe(false);
    await deviceSession("hp-9", 9, "2026-09-25 10:00:00");
    expect(await superseded(null)).toBe(true);
    // Sesi yang lahir setelah kontak tetap dihitung walau sudah logout.
    await client.execute(
      "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'logout' WHERE session_id = 'hp-9';",
    );
    expect(await superseded("2026-09-25 09:30:00")).toBe(true);
  });

  test("mengakhiri sesi mencabutnya dan menulis satu baris audit", async () => {
    await deviceSession("tablet-9", 9, "2026-09-25 11:00:00");
    await deviceSession("laptop-9b", 9, "2026-09-25 11:05:00");
    await expect(
      sessions.endSessions(
        client,
        { session_id: "tablet-9", reason: "x" },
        ADMIN,
      ),
    ).rejects.toThrow(
      "Give a reason of 3-300 characters for ending the session.",
    );
    await expect(
      sessions.endSessions(client, { reason: "Hilang" }, ADMIN),
    ).rejects.toThrow("Choose one session or one operator.");

    const one = await sessions.endSessions(
      client,
      { session_id: "tablet-9", reason: "Perangkat hilang" },
      ADMIN,
    );
    expect(one.count).toBe(1);
    expect(await revoked("tablet-9")).toMatchObject({
      revoked_reason: sql.SESSION_ENDED_BY_ADMIN,
    });
    await expect(
      sessions.endSessions(
        client,
        { session_id: "tablet-9", reason: "Lagi" },
        ADMIN,
      ),
    ).rejects.toThrow("That session has already ended.");

    const all = await sessions.endSessions(
      client,
      { operator_id: 9, reason: "Keluar dari perusahaan" },
      ADMIN,
    );
    expect(all.count).toBe(1);
    expect(
      (await sessions.listActiveSessions(client)).some(
        (row) => row.operator_id === 9,
      ),
    ).toBe(false);

    const audit = await client.execute(
      "SELECT action, entity_id, summary_json FROM domain_audit_log WHERE entity_type = 'session' ORDER BY rowid;",
    );
    expect(audit.rows.map((row) => String(row.action))).toEqual([
      "session.end",
      "session.end_all",
    ]);
    expect(JSON.parse(String(audit.rows[0]?.summary_json))).toEqual({
      operator_id: 9,
      reason: "Perangkat hilang",
      sessions: 1,
    });
    expect(String(audit.rows[1]?.entity_id)).toBe("operator:9");
  });
});
