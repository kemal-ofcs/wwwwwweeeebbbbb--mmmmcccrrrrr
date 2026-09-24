import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));
const domain = await import("@/lib/server/example-domain");

let client: Client;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  await initDatabaseSchema(client);
});

afterAll(() => client.close());

// Aturannya cerminan `desktop_save_item` / `desktop_record_activity` di
// `commands.rs`; baris yang ditulis kedua sisi wajib berbentuk sama.
describe("domain contoh, jalur Web", () => {
  test("item baru tersimpan dengan bentuk baris yang sama seperti Rust", async () => {
    await domain.saveItem(client, {
      kode_item: " ITM-1 ",
      nama: "Kertas A4",
      harga: 45000,
      status_aktif: "Active",
    });
    const [item] = await domain.listItems(client);
    expect(item).toMatchObject({
      kode_item: "ITM-1",
      nama: "Kertas A4",
      kategori: "",
      harga: 45000,
      status_aktif: "Active",
    });
    expect(item?.update_terakhir).toMatch(/^\d+$/);
  });

  test("simpan ulang memperbarui, bukan menggandakan", async () => {
    await domain.saveItem(client, {
      kode_item: "ITM-1",
      nama: "Kertas A4 70gsm",
      status_aktif: "Inactive",
    });
    const items = await domain.listItems(client);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ nama: "Kertas A4 70gsm", harga: 0 });
  });

  test("masukan tidak sah ditolak, status asing tidak dinormalkan", async () => {
    await expect(domain.saveItem(client, { nama: "Ab" })).rejects.toThrow(
      "Kode item wajib diisi.",
    );
    await expect(
      domain.saveItem(client, { kode_item: "X", nama: "A" }),
    ).rejects.toThrow("Nama item minimal dua karakter.");
    await expect(
      domain.saveItem(client, { kode_item: "X", nama: "Ab", harga: -1 }),
    ).rejects.toThrow("Harga tidak boleh negatif.");
    await expect(
      domain.saveItem(client, {
        kode_item: "X",
        nama: "Ab",
        status_aktif: "aktif",
      }),
    ).rejects.toThrow("Status item harus Aktif atau Nonaktif.");
  });

  test("aktivitas dicatat atas nama operator sesi dan dibatasi 1..1000", async () => {
    await domain.recordActivity(
      client,
      { kode_item: "ITM-1", jenis: "Masuk", jumlah: 5 },
      "OPR001",
    );
    const [activity] = await domain.listActivities(client, undefined);
    expect(activity).toMatchObject({
      kode_item: "ITM-1",
      jenis: "Masuk",
      jumlah: 5,
      keterangan: "",
      kode_operator: "OPR001",
    });
    expect(activity?.event_key).toStartWith("web-activity-record-");
    expect(domain.clampActivityLimit(undefined)).toBe(200);
    expect(domain.clampActivityLimit(0)).toBe(1);
    expect(domain.clampActivityLimit(5000)).toBe(1000);
  });

  test("hapus item", async () => {
    await domain.deleteItem(client, "ITM-1");
    expect(await domain.listItems(client)).toHaveLength(0);
  });
});
