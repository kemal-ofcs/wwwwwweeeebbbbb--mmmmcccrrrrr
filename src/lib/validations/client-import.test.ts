import { describe, expect, test } from "bun:test";
import {
  detectDateOrder,
  type ImportContext,
  type ImportRowInput,
  normalizeImportPhone,
  parseCsv,
  parseSheetDate,
  suggestHeaderMapping,
  validateImportRow,
} from "./client-import";

// Bagian "kembar" memakai vektor yang persis sama dengan `mod tests` di
// `src-tauri/src/desktop/clients.rs`. Ubah keduanya bersamaan.

/** Berkas uji dari pemilik produk, apa adanya (termasuk header `omor Klien`). */
const TES_MAKLON_CSV = `Timelapse Input Data Lead,Kode Asal Lead,PIC Customer Service,Kode Klien,Nama Klien,omor Klien,Alamat Klien,Kota / Kabupaten,Provinsi,Kebutuhan,Kategori Produk,Tanggal Terakhir Update,Jumlah FU,Jawaban PIC,Status Lead
10/3/2026 14:05:00,Meta,Rina,GNI-0261,Auravia Skin,0812-2244-8890,Jl. Merdeka 1,Bandung,Jawa Barat,"Sunscreen SPF 50, 50 ml",Skincare,10/5/2026,2,"Sudah kirim pricelist, klien minta sampel",Hot
10/3/2026 15:05:00,,Rina,GNI-0262,Arsenior,+6282311034657,Jl. Sempurna,,Jawa Barat,"Sunscreen SPF 50, 50 ml",Skincare,12/5/2026,2,"Sudah kirim pricelist, klien minta sampel",Hot`;

describe("layar impor", () => {
  test("CSV ekspor Google Sheets terbaca, termasuk koma dalam kutip", () => {
    const rows = parseCsv(`﻿${TES_MAKLON_CSV}\r\n\r\n`);
    expect(rows).toHaveLength(3);
    expect(rows[1]?.[9]).toBe("Sunscreen SPF 50, 50 ml");
    expect(rows[2]?.[1]).toBe("");
    expect(rows[2]?.[7]).toBe("");
    expect(parseCsv('a,"b ""c"""\n1,2')).toEqual([
      ["a", 'b "c"'],
      ["1", "2"],
    ]);
  });

  test("header ditebak walau salah ketik", () => {
    const [headers] = parseCsv(TES_MAKLON_CSV);
    const mapping = suggestHeaderMapping(headers ?? []);
    expect(mapping.phone).toBe(5);
    expect(mapping.lead_created_at).toBe(0);
    expect(mapping.pic_answer).toBe(13);
    expect(suggestHeaderMapping(["Nama", "Foo"]).name).toBe(-1);
  });

  test("urutan tanggal hanya ditebak bila pasti", () => {
    expect(detectDateOrder(["10/3/2026", "12/5/2026"])).toBeNull();
    expect(detectDateOrder(["25/3/2026 10:00", "1/2/2026"])).toBe("DMY");
    expect(detectDateOrder(["3/25/2026"])).toBe("MDY");
    expect(detectDateOrder(["25/3/2026", "3/25/2026"])).toBeNull();
  });
});

describe("kembar dengan Rust", () => {
  test("tanggal sheet dibaca menurut urutan dan zona", () => {
    const value = (raw: string, order: "DMY" | "MDY", zone: string) =>
      parseSheetDate(raw, order, zone);
    expect(value("10/3/2026 14:05:00", "MDY", "Asia/Jakarta")).toEqual({
      value: "2026-10-03 07:05:00",
    });
    expect(value("10/3/2026 14:05:00", "DMY", "Asia/Jakarta")).toEqual({
      value: "2026-03-10 07:05:00",
    });
    expect(value("12/5/2026", "MDY", "Asia/Jakarta")).toEqual({
      value: "2026-12-04 17:00:00",
    });
    expect(value("2026-10-03", "DMY", "Asia/Makassar")).toEqual({
      value: "2026-10-02 16:00:00",
    });
    expect(value("2026-10-03T08:30", "MDY", "Asia/Jakarta")).toEqual({
      value: "2026-10-03 01:30:00",
    });
    expect(value("3.10.2026 9:05", "DMY", "Asia/Jakarta")).toEqual({
      value: "2026-10-03 02:05:00",
    });
    expect(value("29/2/2028", "DMY", "Asia/Jakarta")).toEqual({
      value: "2028-02-28 17:00:00",
    });
    expect(value("  ", "DMY", "Asia/Jakarta")).toEqual({ empty: true });
    for (const raw of [
      "31/2/2026",
      "13/13/2026",
      "2026/10/03",
      "10/3/26",
      "10/3/2026 25:00",
      "1/1/1999",
      "kemarin",
    ]) {
      expect(value(raw, "DMY", "Asia/Jakarta")).toEqual({
        error: `The date "${raw}" could not be read.`,
      });
    }
  });

  test("nomor sheet tanpa nol di depan diterima", () => {
    expect(normalizeImportPhone("0812-2244-8890")).toBe("6281222448890");
    expect(normalizeImportPhone("+6282311034657")).toBe("6282311034657");
    expect(normalizeImportPhone("812-2244-8890")).toBe("6281222448890");
    expect(normalizeImportPhone("81222448890")).toBe("6281222448890");
    expect(normalizeImportPhone("12345")).toBeNull();
    expect(normalizeImportPhone("7812345678")).toBeNull();
  });

  const base: ImportRowInput = {
    line: 2,
    client_code: " GNI-0261 ",
    name: "Auravia Skin",
    phone: "0812-2244-8890",
    address: "Jl. Merdeka 1",
    city: "Bandung",
    province: "Jawa Barat",
    needs_notes: "Sunscreen SPF 50, 50 ml",
    channel_option_id: "opt-meta",
    product_category_option_id: "opt-skin",
    pic_cs_id: 7,
    lead_created_at: "10/3/2026 14:05:00",
    last_update: "10/2/2026",
    total_followups: "2",
    pic_answer: "Sudah kirim pricelist, klien minta sampel",
  };
  // 2026-10-03 12:00:00 UTC.
  const context: ImportContext = {
    date_order: "MDY",
    timezone: "Asia/Jakarta",
    now_epoch: 1_791_028_800,
    warm_max_days: 7,
  };

  test("baris impor dinormalkan", () => {
    expect(validateImportRow(base, context)).toEqual({
      row: {
        line: 2,
        client_code: "GNI-0261",
        name: "Auravia Skin",
        phone: "6281222448890",
        address: "Jl. Merdeka 1",
        city: "Bandung",
        province: "Jawa Barat",
        needs_notes: "Sunscreen SPF 50, 50 ml",
        channel_option_id: "opt-meta",
        product_category_option_id: "opt-skin",
        pic_cs_id: 7,
        created_at: "2026-10-03 07:05:00",
        last_client_response_at: "2026-10-01 17:00:00",
        total_followups: 2,
        interaction_note:
          "Imported from sheet: Sudah kirim pricelist, klien minta sampel",
        note_truncated: false,
      },
    });
    const empty = validateImportRow(
      {
        ...base,
        client_code: "",
        lead_created_at: "",
        last_update: "",
        total_followups: "",
        pic_answer: "",
        pic_cs_id: null,
      },
      context,
    );
    expect(empty).toMatchObject({
      row: {
        client_code: "",
        created_at: "2026-10-03 12:00:00",
        // D-14: tanpa tanggal = warm + 1 hari sebelum impor (sudah Cold).
        last_client_response_at: "2026-09-25 12:00:00",
        total_followups: 0,
        interaction_note: "",
        pic_cs_id: null,
      },
    });
    const long = validateImportRow(
      { ...base, pic_answer: "x".repeat(1000) },
      context,
    );
    if (!("row" in long)) throw new Error("catatan panjang harus dipotong");
    expect([...long.row.interaction_note]).toHaveLength(1000);
    expect(long.row.note_truncated).toBe(true);
  });

  test("baris impor ditolak dengan alasan", () => {
    const cases: [Partial<ImportRowInput>, string][] = [
      [
        { client_code: "GNI 0261" },
        "Kode Klien may only use letters, digits, and . _ / - (up to 40 characters).",
      ],
      [{ name: "A" }, "The client name must be 2-120 characters."],
      [
        { phone: "12345" },
        "Enter a valid WhatsApp number that starts with 0 or 62.",
      ],
      [
        { channel_option_id: "" },
        "Kode Asal Lead is empty or not matched, and no default was chosen.",
      ],
      [
        { product_category_option_id: " " },
        "Kategori Produk is empty or not matched, and no default was chosen.",
      ],
      [
        { lead_created_at: "2/31/2026" },
        'Timelapse Input Data Lead: The date "2/31/2026" could not be read.',
      ],
      [
        { last_update: "10/5/2026" },
        "Tanggal Terakhir Update is in the future. Check the date order (day/month or month/day).",
      ],
      [
        { total_followups: "2.5" },
        "Jumlah FU must be a whole number from 0 to 10000.",
      ],
      [
        { total_followups: "-1" },
        "Jumlah FU must be a whole number from 0 to 10000.",
      ],
      [
        { total_followups: "10001" },
        "Jumlah FU must be a whole number from 0 to 10000.",
      ],
    ];
    for (const [change, error] of cases) {
      expect(validateImportRow({ ...base, ...change }, context)).toEqual({
        error,
      });
    }
  });
});
