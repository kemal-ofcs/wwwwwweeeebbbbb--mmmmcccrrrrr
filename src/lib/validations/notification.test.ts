import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as rules from "./notification";
import { BATCH_LIST_SQL } from "./production";

// Vektor kembar: `mod tests` di `src-tauri/src/desktop/notifications.rs` memakai
// masukan dan keluaran yang persis sama. Ubah keduanya bersamaan.

const {
  coldDigestWindow,
  companyClock,
  formatCompanyTime,
  isTelegramBotToken,
  renderNotification,
  retryDelayMinutes,
  testMessage,
} = rules;

describe("notifikasi divisi", () => {
  test("jeda coba ulang berhenti setelah lima kali", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMinutes)).toEqual([
      1,
      5,
      15,
      60,
      null,
      null,
    ]);
  });

  test("token bot dikenali", () => {
    expect(
      isTelegramBotToken("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"),
    ).toBe(true);
    expect(
      isTelegramBotToken(" 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw "),
    ).toBe(true);
    expect(isTelegramBotToken("123456789:short")).toBe(false);
    expect(isTelegramBotToken("abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
      false,
    );
    expect(isTelegramBotToken("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(
      false,
    );
  });

  test("waktu perusahaan", () => {
    expect(formatCompanyTime("2026-10-03 07:05:00", "Asia/Jakarta")).toBe(
      "2026-10-03 14:05 WIB",
    );
    expect(formatCompanyTime("2026-10-03T07:05:00Z", "Asia/Makassar")).toBe(
      "2026-10-03 15:05 WITA",
    );
    expect(formatCompanyTime("2026-10-03 20:00:00", "Asia/Jayapura")).toBe(
      "2026-10-04 05:00 WIT",
    );
    expect(formatCompanyTime("rusak", "Asia/Jakarta")).toBe("rusak");
    // 2026-10-03 00:30 UTC = 07:30 WIB.
    expect(companyClock(1_790_987_400, "Asia/Jakarta")).toEqual({
      date: "2026-10-03",
      hour: 7,
    });
  });

  test("jendela ringkasan Cold", () => {
    const window = (last: string | null) =>
      coldDigestWindow("2026-10-10", last, 7, "Asia/Jakarta");
    // Pertama kali: hanya yang menjadi Cold hari ini (respons 2026-10-02 WIB).
    expect(window(null)).toEqual([
      "2026-10-01 17:00:00",
      "2026-10-02 17:00:00",
    ]);
    // Ringkasan terakhir kemarin: sama dengan hari ini saja.
    expect(window("2026-10-09")).toEqual(window(null));
    // Terlewat dua hari: respons 2026-09-30 sampai 2026-10-02.
    expect(window("2026-10-07")).toEqual([
      "2026-09-29 17:00:00",
      "2026-10-02 17:00:00",
    ]);
    // Terlewat jauh: dikejar paling banyak 7 hari (respons mulai 2026-09-26).
    expect(window("2026-09-01")).toEqual([
      "2026-09-25 17:00:00",
      "2026-10-02 17:00:00",
    ]);
    // Sudah dibuat hari ini.
    expect(window("2026-10-10")).toBeNull();
  });

  test("teks pesan", () => {
    const lead = {
      client_name: "Aura Beauty",
      client_code: "KLN-20261003-WB01",
      channel: "Instagram",
      category: "",
      pic: "Rina",
    };
    expect(
      renderNotification(
        "LEAD_NEW",
        lead,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "New lead: Aura Beauty (KLN-20261003-WB01)\nChannel: Instagram, category: -\nPIC: Rina\nRegistered 2026-10-03 14:05 WIB",
    );
    const sample = {
      client_name: "Aura Beauty",
      client_code: "KLN-20261003-WB01",
      brand_name: "Aura Glow",
      revision_index: 2,
      deadline_at: "2026-10-31",
    };
    expect(
      renderNotification(
        "SAMPLE_RND_REVIEW",
        sample,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Sample request waiting for RnD review: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nDeadline: 2026-10-31\nSubmitted 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SAMPLE_WAITING_PAYMENT",
        sample,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Sample fee payment awaited: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nSince 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SAMPLE_PENDING_FEE",
        sample,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Revision 2 is over the free quota and needs a fee decision: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nSince 2026-10-03 14:05 WIB",
    );
    const rnd = {
      ...sample,
      lead_time_days: 14,
      reject_reason: "Factory machine capacity",
    };
    expect(
      renderNotification(
        "SAMPLE_RND_ACCEPTED",
        rnd,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "RnD accepted the sample request: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nSample lead time: 14 days\nAccepted 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SAMPLE_RND_REJECTED",
        rnd,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "RnD rejected the sample request: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nReason: Factory machine capacity\nRejected 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SAMPLE_READY",
        sample,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Sample ready and waiting for a price: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nDeadline: 2026-10-31\nReady 2026-10-03 14:05 WIB",
    );
    const money = {
      ...sample,
      revision_fee_idr: 750_000,
      unit_price_idr: 32_500,
    };
    expect(
      renderNotification(
        "SAMPLE_REVISION_FEE",
        money,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Revision 2 fee set at Rp 750.000: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nAsk the client to pay it.\nSet 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SAMPLE_PRICED",
        money,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Price ready, the sample can be sent: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nUnit price: Rp 32.500\nPriced 2026-10-03 14:05 WIB",
    );
    const digest = {
      date: "2026-10-10",
      leads: [
        { client_name: "Aura", client_code: "KLN-1", pic: "Rina" },
        { client_name: "Bina", client_code: "KLN-2", pic: "" },
      ],
    };
    expect(
      renderNotification(
        "COLD_DIGEST",
        digest,
        "2026-10-10 01:00:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Leads that went Cold (2026-10-10): 2\n- Aura (KLN-1), PIC Rina\n- Bina (KLN-2), PIC -",
    );
    const design = {
      ...sample,
      brief: "Box 50 ml, pastel",
      revision_notes: "Logo bigger",
      rejection_count: 1,
    };
    expect(
      renderNotification(
        "DESIGN_REQUESTED",
        design,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "Design requested: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nBrief: Box 50 ml, pastel\nRequested 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "DUMMY_REVISED",
        design,
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "The client wants dummy revision 1: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nNotes: Logo bigger\nSince 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "CLIENT_RESPONDED",
        {
          ...sample,
          entity_type: "DUMMY",
          decision: "REVISE",
          responder: "Rina",
        },
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "The client answered through the approval link: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nPackaging dummy needs changes by Rina\nAnswered 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "MOU_ACCEPTED",
        {
          ...sample,
          mou_number: "MOU-20261009-WB01",
          dp_amount_idr: 162_500_000,
        },
        "2026-10-03 07:05:00",
        "Asia/Jakarta",
      ),
    ).toBe(
      "MoU accepted, issue the down payment invoice: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nMoU MOU-20261009-WB01, down payment Rp 162.500.000\nAccepted 2026-10-03 14:05 WIB",
    );
    expect(testMessage("RND")).toBe(
      "Company OS test message for the RND group. Notifications are working.",
    );
  });

  test("teks pesan produksi (v3.1)", () => {
    const batch = {
      client_name: "Aura Beauty",
      client_code: "KLN-20261003-WB01",
      brand_name: "Aura Glow",
      batch_code: "BAT-20261010-A101",
      mou_number: "MOU-20261009-A101",
      total_units: 10000,
      po_number: "PO-778",
      supplier: "PT Kimia",
      eta_on: "2026-10-27",
      reason: "Stock out",
      packing_on: "2026-11-05",
      notes: "",
      carton_count: 120,
      produced_units: 9950,
    };
    const at = "2026-10-03 07:05:00";
    expect(renderNotification("BATCH_CREATED", batch, at, "Asia/Jakarta")).toBe(
      "New work order BAT-20261010-A101: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nMoU MOU-20261009-A101, 10000 units\nCreated 2026-10-03 14:05 WIB",
    );
    expect(renderNotification("PO_LATE", batch, at, "Asia/Jakarta")).toBe(
      "Purchase order late: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nWork order BAT-20261010-A101, PO PO-778 from PT Kimia\nNow arriving 2026-10-27: Stock out\nReported 2026-10-03 14:05 WIB",
    );
    const shipped = {
      ...batch,
      delivery_note_no: "SJ-20261120-A101",
      method: "CARRIER",
      carrier: "JNE",
      tracking_no: "JNE123",
      driver_name: "Budi",
      vehicle_plate: "D 1234 AB",
    };
    expect(
      renderNotification("SHIPMENT_SHIPPED", shipped, at, "Asia/Jakarta"),
    ).toBe(
      "Shipped, forward it to the client: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nDelivery note SJ-20261120-A101, JNE, tracking JNE123\nShipped 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification(
        "SHIPMENT_SHIPPED",
        { ...shipped, method: "FLEET" },
        at,
        "Asia/Jakarta",
      ),
    ).toBe(
      "Shipped, forward it to the client: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nDelivery note SJ-20261120-A101, driver Budi (D 1234 AB)\nShipped 2026-10-03 14:05 WIB",
    );
    expect(renderNotification("SHIP_CLEARED", batch, at, "Asia/Jakarta")).toBe(
      "Cleared to ship: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nWork order BAT-20261010-A101: 120 cartons are paid for and can leave the factory.\nCleared 2026-10-03 14:05 WIB",
    );
    expect(renderNotification("BATCH_PACKED", batch, at, "Asia/Jakarta")).toBe(
      "Packing done, issue the settlement invoice: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nWork order BAT-20261010-A101: 120 cartons, 9950 units\nPacked 2026-10-03 14:05 WIB",
    );
    expect(
      renderNotification("BATCH_SCHEDULED", batch, at, "Asia/Jakarta"),
    ).toBe(
      "Production scheduled, packing on 2026-11-05: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nWork order BAT-20261010-A101: -\nSaved 2026-10-03 14:05 WIB",
    );
  });

  test("notifikasi siap kirim memakai aturan BATCH_LIST_SQL yang sama", () => {
    expect(rules.NOTIFY_SHIP_CLEARED_SQL).toContain(
      `FROM (${BATCH_LIST_SQL}) z WHERE`,
    );
  });

  test("setiap SQL dan pesan identik dengan Rust", () => {
    const path = ["desktop", "mobile"]
      .map((dir) =>
        join(import.meta.dir, `../../../src-tauri/src/${dir}/notifications.rs`),
      )
      .find(existsSync);
    expect(path).toBeDefined();
    const rust = readFileSync(path as string, "utf8");
    const shared = Object.entries(rules).filter(
      ([name, value]) =>
        typeof value === "string" &&
        (name.endsWith("_SQL") || name.startsWith("TELEGRAM_TOKEN_")),
    );
    expect(shared.length).toBeGreaterThan(15);
    for (const [name, value] of shared) {
      expect(rust, name).toContain(`"${value}"`);
    }
    for (const [division, permission] of Object.entries(
      rules.NOTIFICATION_PERMISSIONS,
    )) {
      expect(rust).toContain(`"${division}" => Some("${permission}")`);
    }
  });
});
