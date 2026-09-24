import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { verifyPassword } from "@/lib/auth/password";
import { hashSessionToken } from "@/lib/auth/session-token";
import { initDatabaseSchema } from "@/lib/db-schema";
import { insertOperator } from "@/lib/operators/operator-admin";

/**
 * Pemulihan password di luar jalur email.
 *
 * Versi sebelumnya SELALU mengirim email, dan kegagalan pengiriman
 * **membatalkan** permintaannya. Di setiap pemasangan yang belum mengonfigurasi
 * email — termasuk seluruh Mode Database Lokal yang memang tidak punya jaringan
 * — fitur "Lupa Password" mati total. Berkas ini menjaga agar cabang itu tidak
 * kembali diam-diam.
 *
 * Verifikasi wajahnya sengaja TIDAK diuji di sini: ia punya berkas ujinya
 * sendiri, dan menyeret mesin render frame ke sini hanya membuat uji ini lambat
 * tanpa menambah kepastian apa pun tentang jalur penyerahan token.
 */

// Modul ini ditandai `server-only`, penanda build Next.js yang tidak dapat
// di-resolve runner test.
mock.module("server-only", () => ({}));

const {
  approvePasswordReset,
  issuePasswordRecoveryCodes,
  PasswordResetError,
  recoverWithRecoveryCode,
  resolvePasswordResetRoute,
} = await import("@/lib/server/auth/password-reset");

let client: Client;
let operatorId: number;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
  const roles = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'operator' LIMIT 1;",
  );
  const result = await insertOperator(client, {
    kodeOperator: "OPS001",
    name: "Operator Satu",
    username: "operator01",
    email: "operator01@contoh.id",
    noHp: "081200000001",
    password: "PasswordLamaKuat1",
    roleId: Number(roles.rows[0]?.id),
    status: "Active",
  });
  operatorId = result.id;
});

beforeEach(async () => {
  await client.execute("DELETE FROM password_reset_request;");
  await client.execute("DELETE FROM app_session;");
  await client.execute(
    "DELETE FROM setting_gex_system WHERE key = 'password_reset_route';",
  );
  await client.execute(
    "UPDATE master_operator SET password_recovery_codes = NULL, password_recovery_created_at = NULL;",
  );
  await client.execute(
    "UPDATE app_mail_config SET is_active = 0 WHERE id = 'default';",
  );
});

afterAll(() => client.close());

/** Paksa jalur penyerahan token, menimpa deteksi otomatis. */
async function forceRoute(route: "email" | "in_app") {
  await client.execute({
    sql: "INSERT OR REPLACE INTO setting_gex_system (key, value) VALUES ('password_reset_route', ?);",
    args: [route],
  });
}

/**
 * Permintaan yang sudah lolos verifikasi wajah dan menunggu persetujuan.
 *
 * Disisipkan langsung, bukan lewat alur foto: yang diuji di sini adalah
 * penyerahan tokennya, bukan penilaian wajahnya.
 */
async function pendingApproval(id = "req-uji") {
  await client.execute({
    sql: `
      INSERT INTO password_reset_request (
        id, operator_id, identifier_used, contact_channel, contact_target,
        challenge_hash, challenge_sequence, status, delivery_status,
        requested_at, verified_at, expires_at
      ) VALUES (
        ?, ?, 'operator01', 'in_app', 'operator01@contoh.id',
        'hash-tantangan', '["KEDIP"]', 'Pending Verification', 'Awaiting Approval',
        datetime('now'), datetime('now'), datetime('now', '+30 minutes')
      );
    `,
    args: [id, operatorId],
  });
  return id;
}

describe("resolvePasswordResetRoute", () => {
  test("tanpa email aktif, bawaannya persetujuan di aplikasi", async () => {
    expect(await resolvePasswordResetRoute(client)).toBe("in_app");
  });

  test("email yang aktif membuat bawaannya kembali ke email", async () => {
    await client.execute(
      "UPDATE app_mail_config SET is_active = 1 WHERE id = 'default';",
    );
    expect(await resolvePasswordResetRoute(client)).toBe("email");
  });

  test("nilai eksplisit mengalahkan deteksi otomatis, dua arah", async () => {
    // Urutan ini tidak boleh dibalik: satu database yang sama bisa dilayani
    // Web dan Desktop bergantian, dan bila keduanya menyimpulkan jalur
    // berbeda sebuah permintaan akan menunggu persetujuan yang tak diminta.
    await client.execute(
      "UPDATE app_mail_config SET is_active = 1 WHERE id = 'default';",
    );
    await forceRoute("in_app");
    expect(await resolvePasswordResetRoute(client)).toBe("in_app");

    await client.execute(
      "UPDATE app_mail_config SET is_active = 0 WHERE id = 'default';",
    );
    await forceRoute("email");
    expect(await resolvePasswordResetRoute(client)).toBe("email");
  });
});

describe("approvePasswordReset", () => {
  test("token yang diserahkan peninjau benar-benar dapat dipakai", async () => {
    const requestId = await pendingApproval();
    const hasil = await approvePasswordReset(client, operatorId, requestId);

    expect(hasil.token.length).toBeGreaterThan(16);
    expect(hasil.namaOperator).toBe("Operator Satu");
    expect(hasil.berlakuMenit).toBe(30);

    const row = await client.execute(
      "SELECT token_hash, status, delivery_status FROM password_reset_request;",
    );
    // Database hanya boleh memegang hash-nya.
    expect(row.rows[0]?.token_hash).toBe(await hashSessionToken(hasil.token));
    expect(String(row.rows[0]?.token_hash)).not.toContain(hasil.token);
    expect(row.rows[0]?.status).toBe("Sent");
    expect(row.rows[0]?.delivery_status).toBe("Approved");
  });

  test("persetujuan kedua ditolak, sehingga tidak ada dua token hidup", async () => {
    const requestId = await pendingApproval();
    await approvePasswordReset(client, operatorId, requestId);
    await expect(
      approvePasswordReset(client, operatorId, requestId),
    ).rejects.toThrow(PasswordResetError);
  });

  test("permintaan yang kedaluwarsa ditolak dan ditandai", async () => {
    const requestId = await pendingApproval();
    await client.execute({
      sql: "UPDATE password_reset_request SET expires_at = datetime('now', '-1 minutes') WHERE id = ?;",
      args: [requestId],
    });
    await expect(
      approvePasswordReset(client, operatorId, requestId),
    ).rejects.toThrow("has expired");
    const row = await client.execute(
      "SELECT status FROM password_reset_request;",
    );
    expect(row.rows[0]?.status).toBe("Expired");
  });

  test("permintaan yang tidak ada ditolak", async () => {
    await expect(
      approvePasswordReset(client, operatorId, "req-tidak-ada"),
    ).rejects.toThrow("not found");
  });
});

describe("issuePasswordRecoveryCodes & recoverWithRecoveryCode", () => {
  test("database hanya memegang hash kodenya", async () => {
    const codes = await issuePasswordRecoveryCodes(client, operatorId);
    expect(codes).toHaveLength(8);

    const row = await client.execute({
      sql: "SELECT password_recovery_codes FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    const stored = String(row.rows[0]?.password_recovery_codes);
    for (const code of codes) expect(stored).not.toContain(code);
    expect(JSON.parse(stored)).toHaveLength(8);
  });

  test("kode yang sah mengganti password dan mencabut sesi lama", async () => {
    const codes = await issuePasswordRecoveryCodes(client, operatorId);
    await client.execute({
      sql: `
        INSERT INTO app_session (
          session_id, token_hash, operator_id, permission_revision,
          created_at, expires_at, last_seen_at
        ) VALUES ('sesi-lama', 'hash-sesi-lama', ?, 1,
          datetime('now'), datetime('now', '+1 hours'), datetime('now'));
      `,
      args: [operatorId],
    });

    const hasil = await recoverWithRecoveryCode(client, {
      identifier: "operator01",
      code: codes[0] as string,
      newPassword: "PasswordPulihKuat7",
    });
    expect(hasil.sisaKode).toBe(7);

    const operator = await client.execute({
      sql: "SELECT password_hash FROM master_operator WHERE id = ?;",
      args: [operatorId],
    });
    expect(
      (
        await verifyPassword(
          "PasswordPulihKuat7",
          String(operator.rows[0]?.password_hash),
        )
      ).valid,
    ).toBe(true);

    const sessions = await client.execute(
      "SELECT revoked_at FROM app_session WHERE session_id = 'sesi-lama';",
    );
    expect(sessions.rows[0]?.revoked_at).toBeTruthy();
  });

  test("kode sekali pakai benar-benar sekali pakai", async () => {
    const codes = await issuePasswordRecoveryCodes(client, operatorId);
    await recoverWithRecoveryCode(client, {
      identifier: "operator01",
      code: codes[0] as string,
      newPassword: "PasswordPulihKuat7",
    });
    await expect(
      recoverWithRecoveryCode(client, {
        identifier: "operator01",
        code: codes[0] as string,
        newPassword: "PasswordLainKuat8",
      }),
    ).rejects.toThrow("already been used");
  });

  test("pemisah apa pun diterima, sesuai normalisasi Rust", async () => {
    // Cerminan `is_ascii_alphanumeric` di `turso.rs`: kode yang dicetak di
    // satu build dipakai untuk masuk lewat build yang lain, jadi normalisasi
    // yang berbeda menghasilkan hash berbeda untuk kode yang sama.
    const codes = await issuePasswordRecoveryCodes(client, operatorId);
    const kotor = ` ${(codes[0] as string).replace("-", "_").toLowerCase()} `;
    const hasil = await recoverWithRecoveryCode(client, {
      identifier: "operator01",
      code: kotor,
      newPassword: "PasswordPulihKuat7",
    });
    expect(hasil.sisaKode).toBe(7);
  });

  test("akun yang tidak ada dan kode yang salah dijawab sama persis", async () => {
    await issuePasswordRecoveryCodes(client, operatorId);
    const pesan: string[] = [];
    for (const input of [
      { identifier: "operator01", code: "ZZZZ-ZZZZ" },
      { identifier: "tidak-ada", code: "ZZZZ-ZZZZ" },
    ]) {
      try {
        await recoverWithRecoveryCode(client, {
          ...input,
          newPassword: "PasswordPulihKuat7",
        });
      } catch (error) {
        pesan.push((error as Error).message);
      }
    }
    // Membedakan keduanya mengubah layar ini menjadi alat memetakan akun.
    expect(pesan).toHaveLength(2);
    expect(pesan[0]).toBe(pesan[1]);
  });

  test("password baru yang lemah ditolak sebelum kode dikonsumsi", async () => {
    const codes = await issuePasswordRecoveryCodes(client, operatorId);
    await expect(
      recoverWithRecoveryCode(client, {
        identifier: "operator01",
        code: codes[0] as string,
        newPassword: "pendek",
      }),
    ).rejects.toThrow(PasswordResetError);

    // Kodenya harus masih hidup: menolak password lemah tidak boleh
    // menghanguskan satu dari delapan kode cetak.
    const hasil = await recoverWithRecoveryCode(client, {
      identifier: "operator01",
      code: codes[0] as string,
      newPassword: "PasswordPulihKuat7",
    });
    expect(hasil.sisaKode).toBe(7);
  });

  test("menerbitkan ulang membatalkan seluruh kode lama", async () => {
    const lama = await issuePasswordRecoveryCodes(client, operatorId);
    await issuePasswordRecoveryCodes(client, operatorId);
    await expect(
      recoverWithRecoveryCode(client, {
        identifier: "operator01",
        code: lama[0] as string,
        newPassword: "PasswordPulihKuat7",
      }),
    ).rejects.toThrow("already been used");
  });
});
