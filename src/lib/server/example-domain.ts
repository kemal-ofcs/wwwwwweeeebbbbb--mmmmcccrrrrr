import "server-only";

import type { Client } from "@libsql/client";
import { ApiRequestError } from "@/lib/server/http/api-response";

/**
 * Domain contoh (`master_item`, `log_aktivitas`) — jalur Web.
 *
 * Cerminan `desktop_list_items`, `desktop_save_item`, `desktop_delete_item`,
 * `desktop_list_activities`, dan `desktop_record_activity` di `commands.rs`.
 * Kedua sisi menulis ke tabel yang sama, jadi bentuk barisnya wajib identik:
 * kolom teks kosong disimpan sebagai `""` (bukan `NULL`) dan stempel waktu
 * sebagai epoch detik dalam teks, persis seperti Rust. Bentuk yang berbeda
 * membuat hash snapshot menganggap baris itu selalu berubah.
 *
 * Ganti modul ini bersama domain contohnya.
 */

export interface ItemRecord {
  kode_item: string;
  nama: string;
  kategori: string | null;
  harga: number;
  satuan: string | null;
  catatan: string | null;
  status_aktif: "Active" | "Inactive";
  update_terakhir: string;
}

export interface ActivityRecord {
  event_key: string;
  kode_item: string;
  jenis: string;
  jumlah: number;
  keterangan: string | null;
  kode_operator: string | null;
  waktu: string;
}

type Draft = Record<string, unknown>;

// Template literal, bukan kutip biasa: `audit:sql` hanya menyisipkan konstanta
// berbentuk backtick ke query sebelum mem-`prepare`-nya.
const EPOCH_NOW = `CAST(strftime('%s','now') AS TEXT)`;

function invalid(message: string): never {
  throw new ApiRequestError(message, 400);
}

function text(source: Draft, key: string) {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** Sama dengan `Value::as_i64` + `unwrap_or(0)` di Rust. */
function integer(source: Draft, key: string) {
  const value = source[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

function nullableText(value: unknown) {
  return value == null ? null : String(value);
}

export async function listItems(client: Client): Promise<ItemRecord[]> {
  const result = await client.execute(
    `SELECT kode_item, nama, kategori, harga, satuan, catatan, status_aktif, update_terakhir
     FROM master_item ORDER BY nama;`,
  );
  return result.rows.map((row) => ({
    kode_item: String(row.kode_item),
    nama: String(row.nama),
    kategori: nullableText(row.kategori),
    harga: Number(row.harga),
    satuan: nullableText(row.satuan),
    catatan: nullableText(row.catatan),
    status_aktif: row.status_aktif === "Inactive" ? "Inactive" : "Active",
    update_terakhir: String(row.update_terakhir),
  }));
}

export async function saveItem(client: Client, item: Draft) {
  const kodeItem = text(item, "kode_item").trim();
  if (!kodeItem) invalid("Kode item wajib diisi.");
  const nama = text(item, "nama").trim();
  if ([...nama].length < 2) invalid("Nama item minimal dua karakter.");
  const harga = integer(item, "harga");
  if (harga < 0) invalid("Harga tidak boleh negatif.");
  // Nilai asing ditolak, tidak pernah dinormalkan menjadi "Active".
  const status = item.status_aktif ?? "Active";
  if (status !== "Active" && status !== "Inactive") {
    invalid("Status item harus Aktif atau Nonaktif.");
  }

  await client.execute({
    sql: `INSERT INTO master_item
            (kode_item, nama, kategori, harga, satuan, catatan, status_aktif, update_terakhir)
          VALUES (?, ?, ?, ?, ?, ?, ?, ${EPOCH_NOW})
          ON CONFLICT(kode_item) DO UPDATE SET
            nama = excluded.nama,
            kategori = excluded.kategori,
            harga = excluded.harga,
            satuan = excluded.satuan,
            catatan = excluded.catatan,
            status_aktif = excluded.status_aktif,
            update_terakhir = excluded.update_terakhir;`,
    args: [
      kodeItem,
      nama,
      text(item, "kategori"),
      harga,
      text(item, "satuan"),
      text(item, "catatan"),
      status,
    ],
  });
  return kodeItem;
}

export async function deleteItem(client: Client, kodeItem: unknown) {
  const kode = typeof kodeItem === "string" ? kodeItem.trim() : "";
  if (!kode) invalid("Kode item wajib diisi.");
  await client.execute({
    sql: "DELETE FROM master_item WHERE kode_item = ?;",
    args: [kode],
  });
}

/** Batas sama dengan Rust: bawaan 200, dijepit 1..1000. */
export function clampActivityLimit(limit: unknown) {
  const value =
    typeof limit === "number" && Number.isSafeInteger(limit) ? limit : 200;
  return Math.min(Math.max(value, 1), 1000);
}

export async function listActivities(
  client: Client,
  limit: unknown,
): Promise<ActivityRecord[]> {
  const result = await client.execute({
    sql: `SELECT event_key, kode_item, jenis, jumlah, keterangan, kode_operator, waktu
          FROM log_aktivitas ORDER BY waktu DESC LIMIT ?;`,
    args: [clampActivityLimit(limit)],
  });
  return result.rows.map((row) => ({
    event_key: String(row.event_key),
    kode_item: String(row.kode_item),
    jenis: String(row.jenis),
    jumlah: Number(row.jumlah),
    keterangan: nullableText(row.keterangan),
    kode_operator: nullableText(row.kode_operator),
    waktu: String(row.waktu),
  }));
}

export async function recordActivity(
  client: Client,
  activity: Draft,
  kodeOperator: string,
) {
  const kodeItem = text(activity, "kode_item").trim();
  if (!kodeItem) invalid("Kode item wajib diisi.");
  const jenis = text(activity, "jenis").trim();
  if (!jenis) invalid("Jenis aktivitas wajib diisi.");

  // Kunci idempotensi baris, setara `sync::new_event_id` di perangkat. Awalan
  // `web-` membuatnya tidak mungkin bertabrakan dengan kunci buatan perangkat.
  const eventKey = `web-activity-record-${crypto.randomUUID()}`;
  await client.execute({
    sql: `INSERT INTO log_aktivitas
            (event_key, kode_item, jenis, jumlah, keterangan, kode_operator, waktu)
          VALUES (?, ?, ?, ?, ?, ?, ${EPOCH_NOW});`,
    args: [
      eventKey,
      kodeItem,
      jenis,
      integer(activity, "jumlah"),
      text(activity, "keterangan"),
      kodeOperator,
    ],
  });
  return eventKey;
}
