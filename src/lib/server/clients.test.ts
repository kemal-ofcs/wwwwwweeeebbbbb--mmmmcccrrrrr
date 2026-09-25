import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { initDatabaseSchema } from "@/lib/db-schema";

mock.module("server-only", () => ({}));

const ADMIN = { id: 1, role: "Admin" };
const actor = (id: number) => ({ id, role: "CS" });

const domain = await import("@/lib/server/clients");

let client: Client;
let directory: string;
let channelId: string;
let categoryId: string;

beforeAll(async () => {
  // Berkas sementara, bukan `file::memory:`: klien libsql menyerahkan
  // koneksinya ke `transaction()` lalu membuka koneksi baru, dan koneksi baru
  // ke database memori berarti database kosong.
  directory = mkdtempSync(join(tmpdir(), "clients-test-"));
  client = createClient({ url: `file:${join(directory, "app.db")}` });
  await initDatabaseSchema(client);
});

beforeEach(async () => {
  await client.execute("DELETE FROM leads;");
  await client.execute("DELETE FROM clients;");
  await client.execute("DELETE FROM master_option;");
  await client.execute("DELETE FROM device_tag_registry;");
  await client.execute(
    "DELETE FROM setting_gex_system WHERE key IN ('client_code_prefix', 'client_code_web_tag');",
  );
  channelId = (
    await domain.saveMasterOption(
      client,
      {
        kind: "LEAD_CHANNEL",
        code: "ig",
        label: "Instagram",
      },
      ADMIN,
    )
  ).id;
  categoryId = (
    await domain.saveMasterOption(
      client,
      {
        kind: "PRODUCT_CATEGORY",
        code: "SKIN",
        label: "Skincare",
      },
      ADMIN,
    )
  ).id;
});

afterAll(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

function draft(overrides: Record<string, unknown> = {}) {
  return {
    name: "Rina Beauty",
    phone: "0812-3456-7890",
    city: "Bandung",
    channel_option_id: channelId,
    product_category_option_id: categoryId,
    needs_notes: "Serum 30 ml",
    ...overrides,
  };
}

// Aturannya cerminan `desktop_register_client` / `desktop_update_client` /
// `desktop_save_master_option` di `commands.rs`: Web dan perangkat menulis ke
// tabel yang sama, jadi bentuk baris dan pesan penolakannya wajib sama.
describe("klien, jalur Web", () => {
  test("registrasi membuat klien LEAD + lead dengan kode tag Web", async () => {
    const saved = await domain.registerClient(client, draft(), actor(7));
    expect(saved.client_code).toMatch(/^KLN-\d{8}-WB01$/);

    const [row] = await domain.listClients(client);
    expect(row).toMatchObject({
      id: saved.id,
      name: "Rina Beauty",
      phone_normalized: "6281234567890",
      city: "Bandung",
      address: "",
      lifecycle_status: "LEAD",
      created_by: 7,
      pic_cs_id: 7,
      channel_option_id: channelId,
      needs_notes: "Serum 30 ml",
      total_followups: 0,
    });
    // Bentuk `datetime('now')`, sama dengan `clients::utc_timestamp` di Rust.
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row?.last_client_response_at).toBe(row?.created_at);
  });

  test("urutan kode naik, awalan dan tag mengikuti Pengaturan", async () => {
    await domain.registerClient(client, draft(), actor(1));
    await domain.saveClientCodeSettings(client, {
      client_code_prefix: "cus",
      client_code_web_tag: "w1",
    });
    const second = await domain.registerClient(
      client,
      draft({ phone: "081299990000" }),
      actor(1),
    );
    expect(second.client_code).toMatch(/^CUS-\d{8}-W101$/);
    const third = await domain.registerClient(
      client,
      draft({ phone: "081299990001" }),
      actor(1),
    );
    expect(third.client_code).toMatch(/^CUS-\d{8}-W102$/);
  });

  test("nomor WhatsApp yang sama ditolak dengan menyebut pemiliknya", async () => {
    const first = await domain.registerClient(client, draft(), actor(1));
    await expect(
      domain.registerClient(
        client,
        draft({ phone: "+62 812 3456 7890" }),
        actor(1),
      ),
    ).rejects.toThrow(
      `The WhatsApp number 6281234567890 is already registered to client ${first.client_code}.`,
    );
  });

  test("masukan tidak sah ditolak dengan pesan yang sama seperti Rust", async () => {
    await expect(
      domain.registerClient(client, draft({ name: "A" }), actor(1)),
    ).rejects.toThrow("The client name must be 2-120 characters.");
    await expect(
      domain.registerClient(client, draft({ phone: "12345" }), actor(1)),
    ).rejects.toThrow(
      "Enter a valid WhatsApp number that starts with 0 or 62.",
    );
    await expect(
      domain.registerClient(
        client,
        draft({ channel_option_id: categoryId }),
        actor(1),
      ),
    ).rejects.toThrow("Choose an active lead channel.");
    expect(await domain.listClients(client)).toHaveLength(0);
  });

  test("opsi nonaktif tidak bisa dipilih klien baru, tetapi klien lama tetap bisa disunting", async () => {
    const saved = await domain.registerClient(client, draft(), actor(1));
    await domain.saveMasterOption(
      client,
      {
        id: channelId,
        code: "IG",
        label: "Instagram",
        is_active: false,
      },
      ADMIN,
    );
    await expect(
      domain.registerClient(client, draft({ phone: "081200001111" }), actor(1)),
    ).rejects.toThrow("Choose an active lead channel.");

    await domain.updateClient(
      client,
      {
        ...draft({ name: "Rina Beauty Official" }),
        id: saved.id,
      },
      ADMIN,
    );
    const [row] = await domain.listClients(client);
    expect(row).toMatchObject({
      name: "Rina Beauty Official",
      client_code: saved.client_code,
      channel_option_id: channelId,
    });
  });

  test("kode Master Data unik per jenis dan jenis asing ditolak", async () => {
    await expect(
      domain.saveMasterOption(
        client,
        {
          kind: "LEAD_CHANNEL",
          code: "IG",
          label: "Instagram lagi",
        },
        ADMIN,
      ),
    ).rejects.toThrow("Another option of this type already uses that code.");
    // Kode sama di jenis berbeda boleh.
    await domain.saveMasterOption(
      client,
      {
        kind: "PRODUCT_CATEGORY",
        code: "IG",
        label: "Kategori IG",
      },
      ADMIN,
    );
    await expect(
      domain.saveMasterOption(
        client,
        {
          kind: "SUPPLIER",
          code: "X",
          label: "X",
        },
        ADMIN,
      ),
    ).rejects.toThrow("Unknown master data type.");
  });

  test("tag Web tidak boleh memakai tag milik perangkat", async () => {
    await client.execute(
      "INSERT INTO device_tag_registry (tag, client_id, registered_at) VALUES ('01', 'device-a', datetime('now'));",
    );
    await expect(
      domain.saveClientCodeSettings(client, {
        client_code_prefix: "KLN",
        client_code_web_tag: "01",
      }),
    ).rejects.toThrow("That Web tag is already used by a device.");
  });
});
