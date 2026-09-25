import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  CLIENT_CODE_PREFIX_SETTING,
  CLIENT_CODE_WEB_TAG_SETTING,
  CLIENT_NAME_MAX,
  CLIENT_NAME_MIN,
  CLIENT_NOTES_MAX,
  CLIENT_TEXT_MAX,
  companyDateStamp,
  DEFAULT_CLIENT_CODE_PREFIX,
  DEFAULT_CLIENT_CODE_WEB_TAG,
  daysSinceResponse,
  formatClientCode,
  isMasterOptionKind,
  type LeadSegment,
  leadSegment,
  type MasterOptionKind,
  nextClientSequence,
  normalizeCodePrefix,
  normalizeDeviceTag,
  normalizeOptionCode,
  normalizeWhatsapp,
  OPTION_LABEL_MAX,
} from "@/lib/validations/client";

/**
 * Domain klien, lead, dan Master Data — jalur Web.
 *
 * Cerminan `desktop_list_clients`, `desktop_register_client`,
 * `desktop_update_client`, `desktop_list_master_options`,
 * `desktop_save_master_option`, dan `desktop_*_client_code_settings` di
 * `commands.rs`. Web menulis langsung ke database cloud; perangkat melihat
 * perubahannya lewat trigger `sync_pulse`. Bentuk baris WAJIB sama dengan yang
 * ditulis handler push `turso.rs`: teks kosong `""` (bukan `NULL`) dan stempel
 * waktu berbentuk `datetime('now')`. Pesan validasi juga identik dengan Rust.
 */

export interface ClientRecord {
  id: string;
  client_code: string;
  name: string;
  phone_normalized: string;
  address: string;
  city: string;
  province: string;
  lifecycle_status: string;
  /** Dihitung saat dibaca (PRD FR-05.3); `null` untuk klien selain `LEAD`. */
  segment: LeadSegment | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  lead_id: string | null;
  pic_cs_id: number | null;
  pic_cs_name: string | null;
  channel_option_id: string;
  product_category_option_id: string;
  needs_notes: string;
  last_client_response_at: string;
  last_followup_at: string;
  total_followups: number;
  days_since_response: number | null;
}

export interface MasterOptionRecord {
  id: string;
  kind: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
}

export interface ClientCodeSettings {
  client_code_prefix: string;
  client_code_web_tag: string;
  /** Web tidak punya tag perangkat; kolom ini selalu `null` di jalur Web. */
  device_tag: string | null;
}

type Draft = Record<string, unknown>;
type Executor = Client | Transaction;

function clientInvalid(message: string): never {
  throw new ApiRequestError(message, 400);
}

/** Sama dengan `draft_text` di Rust: string di-trim, selain string = kosong. */
function text(source: Draft, key: string) {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function nullableInteger(value: unknown) {
  return value == null ? null : Number(value);
}

export async function listClients(client: Client): Promise<ClientRecord[]> {
  // Jam dan zona waktu dari database, bukan dari server Node (aturan 19).
  const clock = await client.execute(
    "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch;",
  );
  const now = Number(clock.rows[0]?.epoch);
  const timezone = await companyTimezone(client);
  const result = await client.execute(
    `SELECT c.id, c.client_code, c.name, c.phone_normalized, c.address, c.city,
            c.province, c.lifecycle_status, c.created_by, c.created_at, c.updated_at,
            l.id AS lead_id, l.pic_cs_id, l.channel_option_id, l.product_category_option_id,
            l.needs_notes, l.last_client_response_at, l.total_followups,
            l.last_followup_at, o.nama_operator AS pic_cs_name
     FROM clients c
     LEFT JOIN leads l ON l.client_id = c.id
     LEFT JOIN master_operator o ON o.id = l.pic_cs_id
     ORDER BY c.created_at DESC, c.id;`,
  );
  return result.rows.map((row) => {
    const lifecycle = String(row.lifecycle_status);
    const lastResponse = String(row.last_client_response_at ?? "");
    const days = daysSinceResponse(lastResponse, now, timezone);
    return {
      id: String(row.id),
      client_code: String(row.client_code),
      name: String(row.name),
      phone_normalized: String(row.phone_normalized),
      address: String(row.address ?? ""),
      city: String(row.city ?? ""),
      province: String(row.province ?? ""),
      lifecycle_status: lifecycle,
      segment: leadSegment(lifecycle, days),
      created_by: nullableInteger(row.created_by),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      lead_id: row.lead_id == null ? null : String(row.lead_id),
      pic_cs_id: nullableInteger(row.pic_cs_id),
      pic_cs_name: row.pic_cs_name == null ? null : String(row.pic_cs_name),
      channel_option_id: String(row.channel_option_id ?? ""),
      product_category_option_id: String(row.product_category_option_id ?? ""),
      needs_notes: String(row.needs_notes ?? ""),
      last_client_response_at: lastResponse,
      last_followup_at: String(row.last_followup_at ?? ""),
      total_followups: Number(row.total_followups ?? 0),
      days_since_response: days,
    };
  });
}

interface ClientDraft {
  name: string;
  phone: string;
  address: string;
  city: string;
  province: string;
  channel: string;
  category: string;
  needs: string;
}

/** Padanan `option_usable`: opsi aktif, atau nilai yang memang sudah tersimpan. */
async function optionUsable(
  executor: Executor,
  id: string,
  kind: MasterOptionKind,
  current: string | undefined,
) {
  if (!id) return false;
  const result = await executor.execute({
    sql: "SELECT is_active FROM master_option WHERE id = ? AND kind = ?;",
    args: [id, kind],
  });
  const row = result.rows[0];
  if (!row) return false;
  return Number(row.is_active) === 1 || current === id;
}

async function validateClientDraft(
  executor: Executor,
  draft: Draft,
  current?: { channel: string; category: string },
): Promise<ClientDraft> {
  const name = text(draft, "name");
  const length = [...name].length;
  if (length < CLIENT_NAME_MIN || length > CLIENT_NAME_MAX) {
    clientInvalid("The client name must be 2-120 characters.");
  }
  const phone = normalizeWhatsapp(text(draft, "phone"));
  if (!phone) {
    clientInvalid("Enter a valid WhatsApp number that starts with 0 or 62.");
  }
  const address = text(draft, "address");
  const city = text(draft, "city");
  const province = text(draft, "province");
  if (
    [address, city, province].some(
      (value) => [...value].length > CLIENT_TEXT_MAX,
    )
  ) {
    clientInvalid(
      "Address, city, and province can be at most 300 characters each.",
    );
  }
  const needs = text(draft, "needs_notes");
  if ([...needs].length > CLIENT_NOTES_MAX) {
    clientInvalid("Client needs can be at most 2000 characters.");
  }
  const channel = text(draft, "channel_option_id");
  if (
    !(await optionUsable(executor, channel, "LEAD_CHANNEL", current?.channel))
  ) {
    clientInvalid("Choose an active lead channel.");
  }
  const category = text(draft, "product_category_option_id");
  if (
    !(await optionUsable(
      executor,
      category,
      "PRODUCT_CATEGORY",
      current?.category,
    ))
  ) {
    clientInvalid("Choose an active product category.");
  }
  return { name, phone, address, city, province, channel, category, needs };
}

/** Padanan `local_phone_owner` + `duplicate_phone` di Rust. */
async function assertPhoneFree(
  executor: Executor,
  phone: string,
  clientId: string,
) {
  const result = await executor.execute({
    sql: "SELECT client_code FROM clients WHERE phone_normalized = ? AND id <> ? LIMIT 1;",
    args: [phone, clientId],
  });
  const owner = result.rows[0]?.client_code;
  if (owner != null) {
    throw new ApiRequestError(
      `The WhatsApp number ${phone} is already registered to client ${String(owner)}.`,
      409,
    );
  }
}

async function readSetting(executor: Executor, key: string) {
  const result = await executor.execute({
    sql: "SELECT value FROM setting_gex_system WHERE key = ? LIMIT 1;",
    args: [key],
  });
  const value = result.rows[0]?.value;
  return value == null ? "" : String(value);
}

export async function companyTimezone(executor: Executor) {
  const result = await executor.execute(
    "SELECT timezone FROM company_profile WHERE id = 'default_company';",
  );
  const value = result.rows[0]?.timezone;
  const timezone = value == null ? "" : String(value).trim();
  return timezone || "Asia/Jakarta";
}

export async function getClientCodeSettings(
  executor: Executor,
): Promise<ClientCodeSettings> {
  return {
    client_code_prefix:
      normalizeCodePrefix(
        await readSetting(executor, CLIENT_CODE_PREFIX_SETTING),
      ) ?? DEFAULT_CLIENT_CODE_PREFIX,
    client_code_web_tag:
      normalizeDeviceTag(
        await readSetting(executor, CLIENT_CODE_WEB_TAG_SETTING),
      ) ?? DEFAULT_CLIENT_CODE_WEB_TAG,
    device_tag: null,
  };
}

/**
 * Daftarkan lead baru dari Web: satu baris `clients` + satu baris `leads`
 * dengan tag Web (`WB`). Urutan kode dihitung dan barisnya ditulis dalam SATU
 * transaksi tulis, supaya dua CS yang menyimpan bersamaan tidak mendapat kode
 * yang sama; stempel waktu dan tanggal perusahaan diambil dari database.
 */
export async function registerClient(
  client: Client,
  draftInput: Draft,
  operatorId: number,
) {
  const transaction = await client.transaction("write");
  try {
    const draft = await validateClientDraft(transaction, draftInput);
    await assertPhoneFree(transaction, draft.phone, "");

    const clock = await transaction.execute(
      "SELECT CAST(strftime('%s','now') AS INTEGER) AS epoch, datetime('now') AS stamp;",
    );
    const epoch = Number(clock.rows[0]?.epoch);
    const timestamp = String(clock.rows[0]?.stamp);
    const settings = await getClientCodeSettings(transaction);
    const dateStamp = companyDateStamp(
      epoch,
      await companyTimezone(transaction),
    );
    const tag = settings.client_code_web_tag;
    const existing = await transaction.execute({
      sql: "SELECT client_code FROM clients WHERE client_code LIKE ?;",
      args: [`%-${dateStamp}-${tag}__`],
    });
    const sequence = nextClientSequence(
      existing.rows.map((row) => String(row.client_code)),
      dateStamp,
      tag,
    );
    const code =
      sequence == null
        ? null
        : formatClientCode(
            settings.client_code_prefix,
            dateStamp,
            tag,
            sequence,
          );
    if (!code) {
      throw new ApiRequestError(
        "The Web has used up its client codes for today.",
        409,
      );
    }

    const id = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    await transaction.execute({
      sql: `INSERT INTO clients
              (id, client_code, name, phone_normalized, address, city, province,
               lifecycle_status, free_revision_limit, is_white_label, assigned_crm_id,
               created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'LEAD', 1, 0, NULL, ?, ?, ?);`,
      args: [
        id,
        code,
        draft.name,
        draft.phone,
        draft.address,
        draft.city,
        draft.province,
        operatorId,
        timestamp,
        timestamp,
      ],
    });
    // Lead masuk = klien yang menghubungi, jadi itulah respons pertamanya.
    await transaction.execute({
      sql: `INSERT INTO leads
              (id, client_id, pic_cs_id, channel_option_id, product_category_option_id,
               needs_notes, last_followup_at, last_client_response_at, total_followups,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?);`,
      args: [
        leadId,
        id,
        operatorId,
        draft.channel,
        draft.category,
        draft.needs,
        timestamp,
        timestamp,
        timestamp,
      ],
    });
    await transaction.commit();
    return { id, client_code: code };
  } finally {
    transaction.close();
  }
}

/**
 * Ubah data kontak klien dan kebutuhan lead-nya. Kode klien, pembuat, dan
 * kolom interaksi lead tidak ikut berubah — sama dengan `desktop_update_client`.
 */
export async function updateClient(client: Client, draftInput: Draft) {
  const id = text(draftInput, "id");
  const transaction = await client.transaction("write");
  try {
    const current = await transaction.execute({
      sql: `SELECT l.id AS lead_id, l.channel_option_id, l.product_category_option_id
            FROM clients c JOIN leads l ON l.client_id = c.id WHERE c.id = ? LIMIT 1;`,
      args: [id],
    });
    const row = current.rows[0];
    if (!row) throw new ApiRequestError("Client not found.", 404);
    const draft = await validateClientDraft(transaction, draftInput, {
      channel: String(row.channel_option_id),
      category: String(row.product_category_option_id),
    });
    await assertPhoneFree(transaction, draft.phone, id);

    await transaction.execute({
      sql: `UPDATE clients SET name = ?, phone_normalized = ?, address = ?, city = ?,
              province = ?, updated_at = datetime('now') WHERE id = ?;`,
      args: [
        draft.name,
        draft.phone,
        draft.address,
        draft.city,
        draft.province,
        id,
      ],
    });
    await transaction.execute({
      sql: `UPDATE leads SET channel_option_id = ?, product_category_option_id = ?,
              needs_notes = ?, updated_at = datetime('now') WHERE id = ?;`,
      args: [draft.channel, draft.category, draft.needs, String(row.lead_id)],
    });
    await transaction.commit();
    return { id };
  } finally {
    transaction.close();
  }
}

export async function listMasterOptions(
  client: Client,
): Promise<MasterOptionRecord[]> {
  const result = await client.execute(
    `SELECT id, kind, code, label, is_active, sort_order, updated_at
     FROM master_option ORDER BY kind, sort_order, label;`,
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    code: String(row.code),
    label: String(row.label),
    is_active: Number(row.is_active) === 1,
    sort_order: Number(row.sort_order),
    updated_at: String(row.updated_at),
  }));
}

/**
 * Tambah atau ubah satu pilihan Master Data. Opsi tidak pernah dihapus, hanya
 * dinonaktifkan: data lama yang memakainya harus tetap terbaca.
 */
export async function saveMasterOption(
  client: Client,
  option: Draft,
): Promise<MasterOptionRecord> {
  const invalid = (message: string): never => {
    throw new ApiRequestError(message, 400);
  };
  const requestedId = text(option, "id");
  const code =
    normalizeOptionCode(text(option, "code")) ??
    invalid("The code must be 1-20 characters: letters, numbers, _ or -.");
  const label = text(option, "label");
  if (!label || [...label].length > OPTION_LABEL_MAX) {
    invalid("The label must be 1-80 characters.");
  }
  // Sama dengan Rust: selain boolean dianggap aktif.
  const isActive =
    typeof option.is_active === "boolean" ? option.is_active : true;

  const transaction = await client.transaction("write");
  try {
    let id: string;
    let kind: string;
    let sortOrder: number;
    if (!requestedId) {
      const requestedKind = text(option, "kind");
      if (!isMasterOptionKind(requestedKind)) {
        invalid("Unknown master data type.");
      }
      const next = await transaction.execute({
        sql: "SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM master_option WHERE kind = ?;",
        args: [requestedKind],
      });
      id = crypto.randomUUID();
      kind = requestedKind;
      sortOrder = Number(next.rows[0]?.next ?? 10);
    } else {
      const existing = await transaction.execute({
        sql: "SELECT kind, sort_order FROM master_option WHERE id = ?;",
        args: [requestedId],
      });
      const row = existing.rows[0];
      if (!row) throw new ApiRequestError("Option not found.", 404);
      id = requestedId;
      kind = String(row.kind);
      sortOrder = Number(row.sort_order);
    }
    const taken = await transaction.execute({
      sql: "SELECT COUNT(*) AS total FROM master_option WHERE kind = ? AND code = ? AND id <> ?;",
      args: [kind, code, id],
    });
    if (Number(taken.rows[0]?.total ?? 0) > 0) {
      invalid("Another option of this type already uses that code.");
    }
    await transaction.execute({
      sql: `INSERT INTO master_option (id, kind, code, label, is_active, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              code = excluded.code,
              label = excluded.label,
              is_active = excluded.is_active,
              sort_order = excluded.sort_order,
              updated_at = excluded.updated_at;`,
      args: [id, kind, code, label, isActive ? 1 : 0, sortOrder],
    });
    const saved = await transaction.execute({
      sql: "SELECT updated_at FROM master_option WHERE id = ?;",
      args: [id],
    });
    await transaction.commit();
    return {
      id,
      kind,
      code,
      label,
      is_active: isActive,
      sort_order: sortOrder,
      updated_at: String(saved.rows[0]?.updated_at ?? ""),
    };
  } finally {
    transaction.close();
  }
}

/**
 * Simpan awalan kode klien dan tag Web. Tag Web tidak boleh sama dengan tag
 * yang sudah dipegang sebuah perangkat (`device_tag_registry`), karena kode
 * klien keduanya akan bertabrakan.
 */
export async function saveClientCodeSettings(
  client: Client,
  settings: Draft,
): Promise<ClientCodeSettings> {
  const invalid = (message: string): never => {
    throw new ApiRequestError(message, 400);
  };
  const prefix =
    normalizeCodePrefix(text(settings, "client_code_prefix")) ??
    invalid("The client code prefix must be 2-5 letters.");
  const webTag =
    normalizeDeviceTag(text(settings, "client_code_web_tag")) ??
    invalid("The Web tag must be exactly 2 letters or numbers.");

  const transaction = await client.transaction("write");
  try {
    const current = await getClientCodeSettings(transaction);
    if (webTag !== current.client_code_web_tag) {
      const taken = await transaction.execute({
        sql: "SELECT COUNT(*) AS total FROM device_tag_registry WHERE tag = ?;",
        args: [webTag],
      });
      if (Number(taken.rows[0]?.total ?? 0) > 0) {
        invalid("That Web tag is already used by a device.");
      }
    }
    for (const [key, value] of [
      [CLIENT_CODE_PREFIX_SETTING, prefix],
      [CLIENT_CODE_WEB_TAG_SETTING, webTag],
    ] as const) {
      await transaction.execute({
        sql: "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        args: [key, value],
      });
    }
    await transaction.commit();
  } finally {
    transaction.close();
  }
  return {
    client_code_prefix: prefix,
    client_code_web_tag: webTag,
    device_tag: null,
  };
}
