import "server-only";

import type { Client } from "@libsql/client";

/**
 * Identitas perusahaan pemakai aplikasi — jalur Web.
 *
 * Cerminan `desktop_get_company_profile` / `desktop_update_company_profile` di
 * `commands.rs`. Kedua sisi menulis ke tabel yang sama, jadi bentuk baris yang
 * dihasilkan wajib identik: satu kolom yang diisi string kosong di satu sisi
 * dan `NULL` di sisi lain akan membuat perbandingan hash snapshot menganggap
 * baris itu selalu berubah, dan setiap siklus sinkronisasi menuliskannya ulang.
 */

/** Baris ini tunggal, selamanya. Kuncinya konstanta, bukan hasil generate. */
export const COMPANY_PROFILE_ID = "default_company";

/** Zona waktu bawaan bila pemasangan belum menentukannya. */
export const DEFAULT_TIMEZONE = "Asia/Jakarta";

export interface CompanyProfile {
  id: string;
  company_name: string;
  branch_name: string | null;
  logo_url: string | null;
  signature_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  leader_name: string | null;
  leader_title: string | null;
  timezone: string;
  updated_at: string;
}

export class CompanyProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "CompanyProfileError";
  }
}

/** Kolom bebas-isi, diperlakukan sama persis oleh kedua sisi. */
const OPTIONAL_FIELDS = [
  "branch_name",
  "logo_url",
  "signature_url",
  "address",
  "phone",
  "email",
  "website",
  "leader_name",
  "leader_title",
] as const;

function text(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Kosong berarti `NULL`, bukan string kosong.
 *
 * Rust melakukan hal yang sama. Kalau kedua sisi berbeda di sini, baris yang
 * secara semantik sama akan menghasilkan hash yang berbeda dan sinkronisasi
 * menuliskannya ulang tanpa henti.
 */
function optional(source: Record<string, unknown>, key: string) {
  const value = text(source, key);
  return value === "" ? null : value;
}

function rowToProfile(row: Record<string, unknown>): CompanyProfile {
  const nullable = (key: string) => {
    const value = row[key];
    return value == null ? null : String(value);
  };
  return {
    id: String(row.id ?? COMPANY_PROFILE_ID),
    company_name: String(row.company_name ?? ""),
    branch_name: nullable("branch_name"),
    logo_url: nullable("logo_url"),
    signature_url: nullable("signature_url"),
    address: nullable("address"),
    phone: nullable("phone"),
    email: nullable("email"),
    website: nullable("website"),
    leader_name: nullable("leader_name"),
    leader_title: nullable("leader_title"),
    timezone: String(row.timezone ?? DEFAULT_TIMEZONE),
    updated_at: String(row.updated_at ?? ""),
  };
}

/**
 * Baca identitas perusahaan.
 *
 * Pemasangan yang belum pernah menyuntingnya menerima nilai bawaan TANPA baris
 * apa pun ditulis. Menyeed baris di sini akan membuat setiap perangkat baru
 * mendorong "Company Name" ke cloud, dan perangkat yang sinkron belakangan
 * menimpa identitas asli yang sudah diisi orang lain.
 */
export async function readCompanyProfile(
  client: Client,
): Promise<CompanyProfile> {
  const result = await client.execute({
    sql: `
      SELECT id, company_name, branch_name, logo_url, signature_url, address,
             phone, email, website, leader_name, leader_title, timezone, updated_at
      FROM company_profile WHERE id = ? LIMIT 1;
    `,
    args: [COMPANY_PROFILE_ID],
  });

  const row = result.rows[0];
  if (!row) {
    return {
      id: COMPANY_PROFILE_ID,
      company_name: "Company Name",
      branch_name: null,
      logo_url: null,
      signature_url: null,
      address: null,
      phone: null,
      email: null,
      website: null,
      leader_name: null,
      leader_title: null,
      timezone: DEFAULT_TIMEZONE,
      updated_at: "",
    };
  }
  return rowToProfile(row as unknown as Record<string, unknown>);
}

/**
 * Simpan identitas perusahaan.
 *
 * `updated_at` dihitung SQLite lewat `datetime('now')`, tidak pernah
 * `new Date()`: baris ini ditulis Rust di perangkat dan TypeScript di sini,
 * dan `new Date("2026-01-01 10:00:00")` diparsing sebagai waktu LOKAL sehingga
 * dua sisi akan menyimpan stempel yang berbeda untuk saat yang sama.
 */
export async function saveCompanyProfile(
  client: Client,
  draft: Record<string, unknown>,
): Promise<CompanyProfile> {
  const companyName = text(draft, "company_name");
  if (companyName.length < 2) {
    throw new CompanyProfileError("Nama perusahaan minimal dua karakter.");
  }
  const timezone = text(draft, "timezone") || DEFAULT_TIMEZONE;

  await client.execute({
    sql: `
      INSERT INTO company_profile
        (id, company_name, branch_name, logo_url, signature_url,
         address, phone, email, website,
         leader_name, leader_title, timezone, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        branch_name = excluded.branch_name,
        logo_url = excluded.logo_url,
        signature_url = excluded.signature_url,
        address = excluded.address,
        phone = excluded.phone,
        email = excluded.email,
        website = excluded.website,
        leader_name = excluded.leader_name,
        leader_title = excluded.leader_title,
        timezone = excluded.timezone,
        updated_at = excluded.updated_at;
    `,
    args: [
      COMPANY_PROFILE_ID,
      companyName,
      ...OPTIONAL_FIELDS.map((field) => optional(draft, field)),
      timezone,
    ],
  });

  return readCompanyProfile(client);
}
