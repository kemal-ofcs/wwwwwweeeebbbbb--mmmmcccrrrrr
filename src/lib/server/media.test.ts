import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";
import { MEDIA_INSERT_SQL, MEDIA_NOT_WEBP } from "@/lib/validations/media";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const clients = await import("@/lib/server/clients");
const samples = await import("@/lib/server/samples");
const media = await import("@/lib/server/media");
const business = await import("@/lib/server/business-settings");

const TINY_WEBP = "UklGRgwAAABXRUJQVlA4TA==";

let client: Client;
let directory: string;
let freeSample: string;
let paidSample: string;

function rustSource(dir: string, file: string) {
  const path = [`${dir}`, "mobile"]
    .map((name) =>
      join(import.meta.dir, `../../../src-tauri/src/${name}/${file}`),
    )
    .find(existsSync);
  expect(path).toBeDefined();
  return readFileSync(path as string, "utf8");
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "media-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
  await client.execute(
    "INSERT INTO master_operator (id, kode_operator, nama_operator, username, password_hash, status) VALUES (1, 'SPD001', 'Kemal Admin', 'kemal', 'x', 'Active');",
  );
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
  const owner = await clients.registerClient(
    client,
    {
      name: "Aura",
      phone: "081299990000",
      channel_option_id: channel.id,
      product_category_option_id: category.id,
    },
    ADMIN,
  );
  const draft = {
    client_id: owner.id,
    product_category_option_id: category.id,
    sample_qty: 1,
    brand_name: "Aura",
    packaging: "Jar",
    deadline_at: "2026-10-31",
    ship_to_address: "Bandung",
    is_dummy_required: false,
  };
  freeSample = (
    await samples.createSampleRequest(
      client,
      { ...draft, is_paid_sample: false },
      ADMIN,
    )
  ).id;
  paidSample = (
    await samples.createSampleRequest(
      client,
      { ...draft, is_paid_sample: true },
      ADMIN,
    )
  ).id;
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("foto tiket, jalur Web", () => {
  test("SQL foto identik dengan Rust", () => {
    expect(rustSource("desktop", "samples.rs")).toContain(
      `"${MEDIA_INSERT_SQL}"`,
    );
    expect(rustSource("desktop", "commands.rs")).toContain(
      `"${media.SAMPLE_MEDIA_LIST_SQL}"`,
    );
  });

  test("unggah, daftar tanpa isi, lalu ambil isinya", async () => {
    const saved = await media.uploadSampleMedia(
      client,
      { sample_id: freeSample, purpose: "REFERENCE", data_base64: TINY_WEBP },
      ADMIN,
    );
    expect(saved.byte_size).toBe(16);
    const detail = await samples.getSampleRequest(client, freeSample);
    expect(detail.media).toEqual([
      expect.objectContaining({
        id: saved.id,
        purpose: "REFERENCE",
        byte_size: 16,
        created_by_name: "Kemal Admin",
        has_data: 1,
      }),
    ]);
    expect(JSON.stringify(detail.media)).not.toContain(TINY_WEBP);
    expect(await media.getMediaData(client, saved.id)).toEqual({
      id: saved.id,
      mime: "image/webp",
      data_base64: TINY_WEBP,
    });
    const audit = await client.execute(
      "SELECT COUNT(*) AS total FROM domain_audit_log WHERE action = 'sample.photo';",
    );
    expect(Number(audit.rows[0]?.total)).toBe(1);
  });

  test("bukti bayar hanya untuk sampel berbayar; bukan WebP ditolak", async () => {
    await expect(
      media.uploadSampleMedia(
        client,
        {
          sample_id: freeSample,
          purpose: "PAYMENT_PROOF",
          data_base64: TINY_WEBP,
        },
        ADMIN,
      ),
    ).rejects.toThrow("Payment proof is only for paid samples.");
    await media.uploadSampleMedia(
      client,
      {
        sample_id: paidSample,
        purpose: "PAYMENT_PROOF",
        data_base64: TINY_WEBP,
      },
      ADMIN,
    );
    await expect(
      media.uploadSampleMedia(
        client,
        {
          sample_id: paidSample,
          purpose: "REFERENCE",
          data_base64: "iVBORw0KGgoAAAANSUhEUg==",
        },
        ADMIN,
      ),
    ).rejects.toThrow(MEDIA_NOT_WEBP);
  });

  test("batas foto dari setelan bisnis; tiket tertutup menolak foto", async () => {
    await business.saveBusinessSettings(
      client,
      {
        default_free_revision_limit: 1,
        sample_fee_mode: "PER_REQUEST",
        lead_hot_max_days: 3,
        lead_warm_max_days: 7,
        max_photos_per_sample: 2,
      },
      ADMIN,
    );
    await media.uploadSampleMedia(
      client,
      { sample_id: freeSample, purpose: "REFERENCE", data_base64: TINY_WEBP },
      ADMIN,
    );
    await expect(
      media.uploadSampleMedia(
        client,
        { sample_id: freeSample, purpose: "REFERENCE", data_base64: TINY_WEBP },
        ADMIN,
      ),
    ).rejects.toThrow(
      "This sample request already has the most photos allowed (2).",
    );
    await samples.recordSampleStep(
      client,
      { id: paidSample, action: "CANCEL", notes: "Klien batal" },
      ADMIN,
    );
    await expect(
      media.uploadSampleMedia(
        client,
        { sample_id: paidSample, purpose: "REFERENCE", data_base64: TINY_WEBP },
        ADMIN,
      ),
    ).rejects.toThrow("This sample request is closed.");
  });
});
