import type { Client } from "@libsql/client";
import { hashPassword } from "@/lib/auth/password";
import {
  assertOperatorContact,
  normalizeOperatorEmail,
  normalizeOperatorPhone,
} from "@/lib/operators/contact";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";

export function validateOperatorDraft(draft: OperatorDraft) {
  const code = draft.kodeOperator.trim().toUpperCase();
  const username = draft.username.trim();
  if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
    throw new Error(
      "The operator code must be 3-24 characters: letters, numbers, _ or -.",
    );
  }
  if (draft.name.trim().length < 3) {
    throw new Error("Nama operator minimal 3 karakter.");
  }
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    throw new Error("The username must be 3-40 characters with no spaces.");
  }
  // Email dan nomor HP wajib pada setiap penyimpanan, termasuk saat menyunting
  // akun lama. Email adalah satu-satunya jalur pengiriman link "Lupa Password".
  assertOperatorContact(draft.email, draft.noHp);
  if (!Number.isSafeInteger(draft.roleId) || draft.roleId < 1) {
    throw new Error("Choose a role for the operator.");
  }
  if (draft.status !== "Active" && draft.status !== "Inactive") {
    throw new Error("Invalid operator status.");
  }
}

function toOperatorRecord(row: Record<string, unknown>): OperatorRecord {
  return {
    id: Number(row.id),
    kodeOperator: String(row.kode_operator),
    name: String(row.nama_operator),
    username: String(row.username),
    email: row.email == null ? "" : String(row.email),
    noHp: row.no_hp == null ? "" : String(row.no_hp),
    totpEnabled: Number(row.totp_enabled ?? 0) === 1,
    roleId: Number(row.role_id),
    roleKey: String(row.role_key),
    roleName: String(row.nama_role),
    isSuperadmin: Number(row.is_superadmin) === 1,
    status: String(row.status) === "Inactive" ? "Inactive" : "Active",
  };
}

export async function listOperators(client: Client) {
  const result = await client.execute(`
    SELECT
      m.id, m.kode_operator, m.nama_operator, m.username, m.email, m.no_hp,
      COALESCE(m.totp_enabled, 0) AS totp_enabled,
      m.role_id, m.status,
      r.role_key, r.nama_role, r.is_superadmin
    FROM master_operator m
    JOIN app_role r ON r.id = m.role_id
    ORDER BY r.is_superadmin DESC, m.nama_operator ASC;
  `);
  return result.rows.map((row) =>
    toOperatorRecord(row as unknown as Record<string, unknown>),
  );
}

async function getLegacyRole(client: Client, roleId: number) {
  const role = await client.execute({
    sql: "SELECT role_key FROM app_role WHERE id = ? AND status = 'Active' LIMIT 1;",
    args: [roleId],
  });
  if (role.rows.length === 0) throw new Error("Active role not found.");
  const roleKey = String(role.rows[0]?.role_key);
  return ["admin", "scanner"].includes(roleKey)
    ? `${roleKey.charAt(0).toUpperCase()}${roleKey.slice(1)}`
    : "Operator";
}

export async function insertOperator(client: Client, draft: OperatorDraft) {
  validateOperatorDraft(draft);
  if (!draft.password) throw new Error("The operator password is required.");
  const result = await client.execute({
    sql: `
      INSERT INTO master_operator (
        kode_operator, nama_operator, username, email, no_hp,
        password_hash, role, role_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    args: [
      draft.kodeOperator.trim().toUpperCase(),
      draft.name.trim(),
      draft.username.trim(),
      normalizeOperatorEmail(draft.email),
      normalizeOperatorPhone(draft.noHp),
      await hashPassword(draft.password),
      await getLegacyRole(client, draft.roleId),
      draft.roleId,
      draft.status,
    ],
  });
  return { success: true, id: Number(result.lastInsertRowid) };
}

export async function bootstrapSuperadmin(
  client: Client,
  draft: Omit<OperatorDraft, "roleId">,
) {
  if (draft.kodeOperator.trim().toUpperCase() !== "SPD001") {
    throw new Error("The Superadmin bootstrap code must be SPD001.");
  }
  if (!draft.password) throw new Error("The Superadmin password is required.");

  const existing = await client.execute(`
    SELECT COUNT(*) AS total
    FROM master_operator m JOIN app_role r ON r.id = m.role_id
    WHERE m.status = 'Active' AND r.is_superadmin = 1;
  `);
  if (Number(existing.rows[0]?.total) > 0) {
    throw new Error(
      "Bootstrap is closed because an active Superadmin already exists.",
    );
  }

  const role = await client.execute(
    "SELECT id FROM app_role WHERE role_key = 'superadmin' AND status = 'Active' LIMIT 1;",
  );
  const roleId = Number(role.rows[0]?.id);
  if (!Number.isSafeInteger(roleId)) {
    throw new Error("No active Superadmin role exists yet.");
  }
  return insertOperator(client, { ...draft, roleId });
}

export async function editOperator(
  client: Client,
  actorId: number,
  operatorId: number,
  draft: OperatorDraft,
) {
  validateOperatorDraft(draft);
  const target = await client.execute({
    sql: `
      SELECT m.id, m.status, r.is_superadmin
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  if (target.rows.length === 0) throw new Error("Operator not found.");
  const nextRole = await client.execute({
    sql: "SELECT is_superadmin, status FROM app_role WHERE id = ? LIMIT 1;",
    args: [draft.roleId],
  });
  if (
    nextRole.rows.length === 0 ||
    String(nextRole.rows[0]?.status) !== "Active"
  ) {
    throw new Error("The target role was not found or is inactive.");
  }
  const removesActiveSuperadmin =
    Number(target.rows[0]?.is_superadmin) === 1 &&
    String(target.rows[0]?.status) === "Active" &&
    (draft.status !== "Active" ||
      Number(nextRole.rows[0]?.is_superadmin) !== 1);
  if (removesActiveSuperadmin) {
    const count = await client.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.status = 'Active' AND r.is_superadmin = 1;
    `);
    if (Number(count.rows[0]?.total) <= 1) {
      throw new Error("The last active Superadmin cannot be deactivated.");
    }
  }

  const updates = [
    "kode_operator = ?",
    "nama_operator = ?",
    "username = ?",
    "email = ?",
    "no_hp = ?",
    "role = ?",
    "role_id = ?",
    "status = ?",
  ];
  const args: (string | number)[] = [
    draft.kodeOperator.trim().toUpperCase(),
    draft.name.trim(),
    draft.username.trim(),
    normalizeOperatorEmail(draft.email),
    normalizeOperatorPhone(draft.noHp),
    await getLegacyRole(client, draft.roleId),
    draft.roleId,
    draft.status,
  ];
  if (draft.password) {
    updates.push("password_hash = ?");
    args.push(await hashPassword(draft.password));
  }
  args.push(operatorId);
  await client.execute({
    sql: `UPDATE master_operator SET ${updates.join(", ")} WHERE id = ?;`,
    args,
  });

  await revokeOperatorSessions(
    client,
    operatorId,
    actorId === operatorId
      ? "self-security-update"
      : "operator-security-update",
  );
  return { success: true };
}

export async function removeOperator(
  client: Client,
  actorId: number,
  operatorId: number,
) {
  if (actorId === operatorId) {
    throw new Error("The account in use cannot be deleted.");
  }
  const target = await client.execute({
    sql: `
      SELECT m.kode_operator, m.status, r.is_superadmin
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.id = ? LIMIT 1;
    `,
    args: [operatorId],
  });
  if (target.rows.length === 0) throw new Error("Operator not found.");
  const operatorCode = String(target.rows[0]?.kode_operator);
  if (
    Number(target.rows[0]?.is_superadmin) === 1 &&
    String(target.rows[0]?.status) === "Active"
  ) {
    const count = await client.execute(`
      SELECT COUNT(*) AS total
      FROM master_operator m JOIN app_role r ON r.id = m.role_id
      WHERE m.status = 'Active' AND r.is_superadmin = 1;
    `);
    if (Number(count.rows[0]?.total) <= 1) {
      throw new Error("The last active Superadmin cannot be deleted.");
    }
  }

  // Hanya tabel yang ada di skema ini. Daftar lama juga menghitung tabel milik
  // proyek asal (`log_scan`, `koreksi_admin`, `backup_karyawan`), sehingga
  // setiap penghapusan gagal dengan "no such table".
  const references = await client.execute({
    sql: "SELECT COUNT(*) AS total FROM role_permission_audit WHERE changed_by = ?;",
    args: [operatorCode],
  });
  if (Number(references.rows[0]?.total) > 0) {
    throw new Error(
      "This operator has transaction history. Deactivate the account so the audit trail stays intact.",
    );
  }

  const resetHistory = await client.execute({
    sql: "SELECT COUNT(*) AS total FROM password_reset_request WHERE operator_id = ?;",
    args: [operatorId],
  });
  if (Number(resetHistory.rows[0]?.total) > 0) {
    throw new Error(
      "This operator has password reset requests with verification photos. Delete that history first, or deactivate the account so the audit evidence stays intact.",
    );
  }

  await client.execute({
    sql: "DELETE FROM master_operator WHERE id = ?;",
    args: [operatorId],
  });
  return { success: true };
}

export async function revokeOperatorSessions(
  client: Client,
  operatorId: number,
  reason: string,
) {
  await client.execute({
    sql: `
      UPDATE app_session SET revoked_at = ?, revoked_reason = ?
      WHERE operator_id = ? AND revoked_at IS NULL;
    `,
    args: [new Date().toISOString(), reason, operatorId],
  });
}

export async function revokeRoleSessions(
  client: Client,
  roleId: number,
  reason: string,
) {
  await client.execute({
    sql: `
      UPDATE app_session SET revoked_at = ?, revoked_reason = ?
      WHERE operator_id IN (
        SELECT id FROM master_operator WHERE role_id = ?
      ) AND revoked_at IS NULL;
    `,
    args: [new Date().toISOString(), reason, roleId],
  });
}
