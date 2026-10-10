/**
 * Notifikasi divisi (PRD FR-08): satu kejadian tampil di lonceng aplikasi dan,
 * bila bot aktif dan chat ID divisinya terisi, dikirim ke grup Telegram.
 *
 * WAJIB identik dengan `src-tauri/src/desktop/notifications.rs`. Kedua sisi
 * diuji dengan vektor yang sama (`notification.test.ts` dan `mod tests` di
 * sana), dan setiap konstanta SQL di bawah dites ada per karakter di Rust:
 * baris yang sama diklaim dan dikirim Web maupun perangkat.
 */

import {
  companyDayBoundsUtc,
  parseStoredTimestamp,
  timezoneOffsetHours,
  utcTimestamp,
} from "./client";
import { formatRupiah } from "./sample";

export const NOTIFICATION_DIVISIONS = [
  "CS",
  "RND",
  "FINANCE",
  "DESIGN",
  // PPIC, SPV, QC, dan Logistik berbagi satu grup (v3.1, D-43).
  "PRODUCTION",
] as const;
export type NotificationDivision = (typeof NOTIFICATION_DIVISIONS)[number];

/** Izin per divisi: siapa melihat kejadian divisi itu di lonceng. */
export const NOTIFICATION_PERMISSIONS = {
  CS: "notifications_cs.view",
  RND: "notifications_rnd.view",
  FINANCE: "notifications_finance.view",
  DESIGN: "notifications_design.view",
  PRODUCTION: "notifications_production.view",
} as const satisfies Record<NotificationDivision, string>;

export const NOTIFICATION_EVENT_TYPES = [
  "LEAD_NEW",
  "COLD_DIGEST",
  "SAMPLE_RND_REVIEW",
  "SAMPLE_WAITING_PAYMENT",
  "SAMPLE_PENDING_FEE",
  // Hasil langkah RnD untuk grup CS (v2.1, PRD F-14 dan E-23).
  "SAMPLE_RND_ACCEPTED",
  "SAMPLE_RND_REJECTED",
  "SAMPLE_READY",
  // Finance (v2.2, PRD F-15/F-16): tarif revisi dan harga untuk grup CS.
  "SAMPLE_REVISION_FEE",
  "SAMPLE_PRICED",
  // Desain (v2.4, PRD F-19): brief baru dan dummy direvisi klien.
  "DESIGN_REQUESTED",
  "DUMMY_REVISED",
  // MoU disetujui klien: Finance menerbitkan tagihan DP (v2.5a).
  "MOU_ACCEPTED",
  // Klien menjawab lewat tautan persetujuan, ke grup CS (v2.5b).
  "CLIENT_RESPONDED",
  // Produksi (v3.1): work order baru, PO terlambat, jadwal disimpan.
  "BATCH_CREATED",
  "PO_LATE",
  "BATCH_SCHEDULED",
  // Packing selesai (v3.2, US-22): CS dan Finance menyiapkan pelunasan.
  "BATCH_PACKED",
  // Pelunasan (dan biaya titip) lunas: Logistik boleh mengirim (v3.3).
  "SHIP_CLEARED",
  // Barang keluar: CS meneruskan resi dan Surat Jalan ke klien (v3.4).
  "SHIPMENT_SHIPPED",
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_MAX_ATTEMPTS = 5;
/** Ringkasan Cold dikirim pada siklus pengirim pertama sejak jam ini (waktu perusahaan). */
export const COLD_DIGEST_HOUR = 8;
/** Ringkasan mengejar hari yang terlewat paling banyak sejauh ini. */
export const COLD_DIGEST_MAX_CATCH_UP_DAYS = 7;

/**
 * Jeda sebelum percobaan berikutnya, setelah `attempts` percobaan gagal.
 * `null` = berhenti, baris menjadi `FAILED`.
 */
export function retryDelayMinutes(attempts: number): number | null {
  if (attempts >= NOTIFICATION_MAX_ATTEMPTS) return null;
  return [1, 5, 15, 60][Math.max(0, attempts - 1)] ?? 60;
}

/** Token dari @BotFather: `<angka>:<rahasia>`. */
export function isTelegramBotToken(value: string): boolean {
  return /^\d{3,20}:[A-Za-z0-9_-]{30,64}$/.test(value.trim());
}

export const TELEGRAM_TOKEN_REQUIRED =
  "Enter the bot token from @BotFather to turn notifications on.";
export const TELEGRAM_TOKEN_INVALID =
  "The bot token looks wrong. Copy it from @BotFather, for example 123456789:AAH...";

// ---------------------------------------------------------------------------
// Waktu perusahaan
// ---------------------------------------------------------------------------

function zoneLabel(timezone: string) {
  const offset = timezoneOffsetHours(timezone);
  return offset === 8 ? "WITA" : offset === 9 ? "WIT" : "WIB";
}

/** `YYYY-MM-DD HH:MM WIB` dari stempel UTC tersimpan; teks apa adanya bila rusak. */
export function formatCompanyTime(stored: string, timezone: string) {
  const epoch = parseStoredTimestamp(stored);
  if (epoch === null) return stored;
  const local = utcTimestamp(epoch + timezoneOffsetHours(timezone) * 3600);
  return `${local.slice(0, 16)} ${zoneLabel(timezone)}`;
}

/** Tanggal (`YYYY-MM-DD`) dan jam perusahaan dari epoch detik UTC. */
export function companyClock(epochSeconds: number, timezone: string) {
  const local = utcTimestamp(
    epochSeconds + timezoneOffsetHours(timezone) * 3600,
  );
  return { date: local.slice(0, 10), hour: Number(local.slice(11, 13)) };
}

function shiftDate(date: string, days: number) {
  const midnight = parseStoredTimestamp(`${date} 00:00:00`);
  return midnight === null
    ? null
    : utcTimestamp(midnight + days * 86_400).slice(0, 10);
}

/**
 * Rentang UTC `[dari, sampai)` untuk `last_client_response_at` lead yang
 * menjadi Cold sejak ringkasan sebelumnya. Lead menjadi Cold pada hari ke
 * `warm + 1` setelah respons terakhirnya (`leadSegment`), jadi hari menjadi
 * Cold `d` berarti respons di hari `d - warm - 1`. Tanpa ringkasan sebelumnya
 * hanya hari ini; hari yang terlewat dikejar paling banyak 7 hari.
 */
export function coldDigestWindow(
  today: string,
  lastDigestDate: string | null,
  warmMaxDays: number,
  timezone: string,
): [string, string] | null {
  const earliest = shiftDate(today, 1 - COLD_DIGEST_MAX_CATCH_UP_DAYS);
  const afterLast = lastDigestDate ? shiftDate(lastDigestDate, 1) : today;
  if (!earliest || !afterLast) return null;
  const firstDay = afterLast > earliest ? afterLast : earliest;
  if (firstDay > today) return null;
  const fromDate = shiftDate(firstDay, -warmMaxDays - 1);
  const toDate = shiftDate(today, -warmMaxDays);
  if (!fromDate || !toDate) return null;
  const from = companyDayBoundsUtc(fromDate, timezone);
  const to = companyDayBoundsUtc(toDate, timezone);
  return from && to ? [from[0], to[0]] : null;
}

// ---------------------------------------------------------------------------
// Teks pesan (teks polos: tanpa parse_mode, jadi nama klien tidak perlu di-escape)
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string) {
  const value = payload[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function rupiah(payload: Payload, key: string) {
  const value = payload[key];
  return typeof value === "number" ? formatRupiah(value) : "-";
}

function orDash(value: string) {
  return value.trim() === "" ? "-" : value;
}

const APPROVAL_KIND_LABEL: Record<string, string> = {
  SAMPLE: "Sample",
  DUMMY: "Packaging dummy",
  MOU: "MoU",
};
const APPROVAL_DECISION_LABEL: Record<string, string> = {
  APPROVE: "approved",
  REVISE: "needs changes",
  REJECT: "rejected",
};

export function renderNotification(
  eventType: string,
  payload: Payload,
  occurredAt: string,
  timezone: string,
): string {
  const when = formatCompanyTime(occurredAt, timezone);
  const client = `${text(payload, "client_name")} (${text(payload, "client_code")})`;
  const sample = `${text(payload, "brand_name")} for ${client}`;
  switch (eventType) {
    case "LEAD_NEW":
      return [
        `New lead: ${client}`,
        `Channel: ${orDash(text(payload, "channel"))}, category: ${orDash(text(payload, "category"))}`,
        `PIC: ${orDash(text(payload, "pic"))}`,
        `Registered ${when}`,
      ].join("\n");
    case "SAMPLE_RND_REVIEW":
      return [
        `Sample request waiting for RnD review: ${sample}`,
        `Deadline: ${orDash(text(payload, "deadline_at"))}`,
        `Submitted ${when}`,
      ].join("\n");
    case "SAMPLE_WAITING_PAYMENT":
      return [`Sample fee payment awaited: ${sample}`, `Since ${when}`].join(
        "\n",
      );
    case "SAMPLE_PENDING_FEE":
      return [
        `Revision ${text(payload, "revision_index")} is over the free quota and needs a fee decision: ${sample}`,
        `Since ${when}`,
      ].join("\n");
    case "SAMPLE_RND_ACCEPTED":
      return [
        `RnD accepted the sample request: ${sample}`,
        `Sample lead time: ${orDash(text(payload, "lead_time_days"))} days`,
        `Accepted ${when}`,
      ].join("\n");
    case "SAMPLE_RND_REJECTED":
      return [
        `RnD rejected the sample request: ${sample}`,
        `Reason: ${orDash(text(payload, "reject_reason"))}`,
        `Rejected ${when}`,
      ].join("\n");
    case "SAMPLE_READY":
      return [
        `Sample ready and waiting for a price: ${sample}`,
        `Deadline: ${orDash(text(payload, "deadline_at"))}`,
        `Ready ${when}`,
      ].join("\n");
    case "SAMPLE_REVISION_FEE":
      return [
        `Revision ${text(payload, "revision_index")} fee set at ${rupiah(payload, "revision_fee_idr")}: ${sample}`,
        "Ask the client to pay it.",
        `Set ${when}`,
      ].join("\n");
    case "SAMPLE_PRICED":
      return [
        `Price ready, the sample can be sent: ${sample}`,
        `Unit price: ${rupiah(payload, "unit_price_idr")}`,
        `Priced ${when}`,
      ].join("\n");
    case "DESIGN_REQUESTED":
      return [
        `Design requested: ${sample}`,
        `Brief: ${orDash(text(payload, "brief"))}`,
        `Requested ${when}`,
      ].join("\n");
    case "DUMMY_REVISED":
      return [
        `The client wants dummy revision ${text(payload, "rejection_count")}: ${sample}`,
        `Notes: ${orDash(text(payload, "revision_notes"))}`,
        `Since ${when}`,
      ].join("\n");
    case "CLIENT_RESPONDED":
      return [
        `The client answered through the approval link: ${sample}`,
        `${APPROVAL_KIND_LABEL[text(payload, "entity_type")] ?? text(payload, "entity_type")} ${APPROVAL_DECISION_LABEL[text(payload, "decision")] ?? text(payload, "decision")} by ${orDash(text(payload, "responder"))}`,
        `Answered ${when}`,
      ].join("\n");
    case "MOU_ACCEPTED":
      return [
        `MoU accepted, issue the down payment invoice: ${sample}`,
        `MoU ${text(payload, "mou_number")}, down payment ${rupiah(payload, "dp_amount_idr")}`,
        `Accepted ${when}`,
      ].join("\n");
    case "BATCH_CREATED":
      return [
        `New work order ${text(payload, "batch_code")}: ${sample}`,
        `MoU ${text(payload, "mou_number")}, ${text(payload, "total_units")} units`,
        `Created ${when}`,
      ].join("\n");
    case "PO_LATE":
      return [
        `Purchase order late: ${sample}`,
        `Work order ${text(payload, "batch_code")}, PO ${text(payload, "po_number")} from ${orDash(text(payload, "supplier"))}`,
        `Now arriving ${text(payload, "eta_on")}: ${orDash(text(payload, "reason"))}`,
        `Reported ${when}`,
      ].join("\n");
    case "BATCH_SCHEDULED":
      return [
        `Production scheduled, packing on ${text(payload, "packing_on")}: ${sample}`,
        `Work order ${text(payload, "batch_code")}: ${orDash(text(payload, "notes"))}`,
        `Saved ${when}`,
      ].join("\n");
    case "BATCH_PACKED":
      return [
        `Packing done, issue the settlement invoice: ${sample}`,
        `Work order ${text(payload, "batch_code")}: ${text(payload, "carton_count")} cartons, ${text(payload, "produced_units")} units`,
        `Packed ${when}`,
      ].join("\n");
    case "SHIPMENT_SHIPPED": {
      const via =
        text(payload, "method") === "FLEET"
          ? `driver ${text(payload, "driver_name")} (${text(payload, "vehicle_plate")})`
          : `${orDash(text(payload, "carrier"))}, tracking ${orDash(text(payload, "tracking_no"))}`;
      return [
        `Shipped, forward it to the client: ${sample}`,
        `Delivery note ${text(payload, "delivery_note_no")}, ${via}`,
        `Shipped ${when}`,
      ].join("\n");
    }
    case "SHIP_CLEARED":
      return [
        `Cleared to ship: ${sample}`,
        `Work order ${text(payload, "batch_code")}: ${text(payload, "carton_count")} cartons are paid for and can leave the factory.`,
        `Cleared ${when}`,
      ].join("\n");
    case "COLD_DIGEST": {
      const leads = Array.isArray(payload.leads)
        ? (payload.leads as Payload[])
        : [];
      return [
        `Leads that went Cold (${text(payload, "date")}): ${leads.length}`,
        ...leads.map(
          (lead) =>
            `- ${text(lead, "client_name")} (${text(lead, "client_code")}), PIC ${orDash(text(lead, "pic"))}`,
        ),
      ].join("\n");
    }
    default:
      return eventType;
  }
}

/** Pesan uji kirim dari Pengaturan. */
export function testMessage(division: NotificationDivision) {
  return `Company OS test message for the ${division} group. Notifications are working.`;
}

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `notifications.rs`.
//
// `id` sekaligus kunci dedupe (`lead-new:<client>`, `sample:<log>`,
// `cold-digest:<tanggal>`): push ulang dan dua pengirim yang berlomba tidak
// pernah menggandakan baris. Tabelnya cloud-only, jadi PK cukup.
// Status Telegram dihitung saat baris lahir: `SKIPPED` bila bot mati atau chat
// ID divisinya kosong, supaya menyalakan bot nanti tidak membanjiri grup.
// ---------------------------------------------------------------------------

/** ?1 = client id. Dipanggil di transaksi registrasi, sesudah baris klien dan lead ada. */
export const NOTIFY_LEAD_NEW_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'lead-new:' || c.id, 'LEAD_NEW', 'CS', json_object('client_id', c.id, 'client_code', c.client_code, 'client_name', c.name, 'channel', COALESCE(ch.label, ''), 'category', COALESCE(cat.label, ''), 'pic', COALESCE(o.nama_operator, '')), c.created_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_option ch ON ch.id = l.channel_option_id LEFT JOIN master_option cat ON cat.id = l.product_category_option_id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.id = ?1 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * ?1 = id baris `sample_status_log` langkah ini, ?2 = sample id. Aman dipanggil
 * setelah setiap langkah: status di luar enam status target tidak menulis apa
 * pun. Antrean RnD ke grup RnD, tagihan ke Finance, hasil RnD ke CS.
 */
export const NOTIFY_SAMPLE_STATUS_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'sample:' || ?1, CASE s.status WHEN 'RND_REVIEW' THEN 'SAMPLE_RND_REVIEW' WHEN 'WAITING_SAMPLE_PAYMENT' THEN 'SAMPLE_WAITING_PAYMENT' WHEN 'PENDING_FEE_ASSESSMENT' THEN 'SAMPLE_PENDING_FEE' WHEN 'RND_ACCEPTED' THEN 'SAMPLE_RND_ACCEPTED' WHEN 'RND_REJECTED' THEN 'SAMPLE_RND_REJECTED' WHEN 'WAITING_REVISION_PAYMENT' THEN 'SAMPLE_REVISION_FEE' ELSE 'SAMPLE_READY' END, CASE WHEN s.status = 'RND_REVIEW' THEN 'RND' WHEN s.status IN ('WAITING_SAMPLE_PAYMENT', 'PENDING_FEE_ASSESSMENT', 'SAMPLE_READY') THEN 'FINANCE' ELSE 'CS' END, json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'revision_index', s.revision_index, 'deadline_at', s.deadline_at, 'lead_time_days', s.rnd_lead_time_days, 'reject_reason', COALESCE(r.label, ''), 'revision_fee_idr', s.revision_fee_idr), s.status_changed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = CASE WHEN s.status = 'RND_REVIEW' THEN 'telegram_chat_id_rnd' WHEN s.status IN ('WAITING_SAMPLE_PAYMENT', 'PENDING_FEE_ASSESSMENT', 'SAMPLE_READY') THEN 'telegram_chat_id_finance' ELSE 'telegram_chat_id_cs' END), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN master_option r ON r.id = s.rnd_reject_reason_option_id WHERE s.id = ?2 AND s.status IN ('RND_REVIEW', 'WAITING_SAMPLE_PAYMENT', 'PENDING_FEE_ASSESSMENT', 'RND_ACCEPTED', 'RND_REJECTED', 'SAMPLE_READY', 'WAITING_REVISION_PAYMENT') LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * Harga Finance tersimpan (v2.2): grup CS boleh mengirim sampel. ?1 = id baris
 * `pricing_formulas`; ditulis di transaksi yang sama dengan harganya.
 */
export const NOTIFY_SAMPLE_PRICED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'price:' || p.id, 'SAMPLE_PRICED', 'CS', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'unit_price_idr', p.final_unit_price_idr, 'iteration_number', p.iteration_number), p.recorded_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM pricing_formulas p JOIN sample_requests s ON s.id = p.sample_request_id LEFT JOIN clients c ON c.id = s.client_id WHERE p.id = ?1 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * Brief desain baru dan dummy yang direvisi klien, ke grup Desain (v2.4).
 * ?1 = id baris `sample_status_log` langkah ini, ?2 = id tiket desain. Status
 * selain `MOCKUP`/`DUMMY_REVISION` tidak menulis apa pun.
 */
export const NOTIFY_DESIGN_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'design:' || ?1, CASE d.status WHEN 'MOCKUP' THEN 'DESIGN_REQUESTED' ELSE 'DUMMY_REVISED' END, 'DESIGN', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'brief', d.brief, 'revision_notes', d.revision_notes, 'rejection_count', d.dummy_rejection_count), d.status_changed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_design'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM design_tickets d JOIN sample_requests s ON s.id = d.sample_request_id LEFT JOIN clients c ON c.id = s.client_id WHERE d.id = ?2 AND d.status IN ('MOCKUP', 'DUMMY_REVISION') LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * Klien menjawab lewat tautan persetujuan, ke grup CS (v2.5b). ?1 = id token,
 * ditulis Web di transaksi yang sama dengan jawabannya.
 */
export const NOTIFY_CLIENT_RESPONSE_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'approval:' || a.id, 'CLIENT_RESPONDED', 'CS', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'entity_type', a.entity_type, 'decision', json_extract(a.response_json, '$.decision'), 'responder', json_extract(a.response_json, '$.responder_name')), a.used_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM approval_tokens a JOIN sample_requests s ON s.id = a.sample_request_id LEFT JOIN clients c ON c.id = s.client_id WHERE a.id = ?1 AND a.used_at IS NOT NULL LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/** MoU disetujui klien, ke grup Finance (v2.5a). ?1 = id log, ?2 = id MoU. */
export const NOTIFY_MOU_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'mou:' || ?1, 'MOU_ACCEPTED', 'FINANCE', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'mou_number', m.mou_number, 'dp_amount_idr', m.dp_amount_required_idr), m.status_changed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_finance'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM production_mou m JOIN sample_requests s ON s.id = m.sample_request_id LEFT JOIN clients c ON c.id = m.client_id WHERE m.id = ?2 AND m.status = 'ACCEPTED' LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * Work order baru, ke grup Production (v3.1). ?1 = id work order; ditulis di
 * transaksi yang sama dengan work order-nya.
 */
export const NOTIFY_BATCH_CREATED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'batch:' || b.id, 'BATCH_CREATED', 'PRODUCTION', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'batch_code', b.batch_code, 'mou_number', m.mou_number, 'total_units', m.total_units), b.created_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_production'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id WHERE b.id = ?1 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/**
 * PO terlambat, ke grup CS dan Production (v3.1, E-30). ?1 = id log langkah,
 * ?2 = id PO. Satu baris per divisi; `id` tetap kunci dedupe.
 */
export const NOTIFY_PO_LATE_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'po-late:' || ?1 || ':' || d.division, 'PO_LATE', d.division, json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'batch_code', b.batch_code, 'po_number', p.po_number, 'supplier', COALESCE(o.label, ''), 'eta_on', p.eta_on, 'reason', p.late_reason), p.updated_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = CASE d.division WHEN 'CS' THEN 'telegram_chat_id_cs' ELSE 'telegram_chat_id_production' END), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM batch_purchase_orders p JOIN production_batches b ON b.id = p.batch_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id LEFT JOIN master_option o ON o.id = p.supplier_option_id CROSS JOIN (SELECT 'CS' AS division UNION ALL SELECT 'PRODUCTION') d WHERE p.id = ?2 ON CONFLICT(id) DO NOTHING;";

/**
 * Packing selesai, ke grup CS dan Finance (v3.2, US-22). ?1 = id log langkah,
 * ?2 = id work order. Hanya bila work order sudah dipacking.
 */
export const NOTIFY_BATCH_PACKED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'packed:' || ?1 || ':' || d.division, 'BATCH_PACKED', d.division, json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'batch_code', b.batch_code, 'mou_number', m.mou_number, 'carton_count', b.carton_count, 'produced_units', b.produced_units), b.packed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = CASE d.division WHEN 'CS' THEN 'telegram_chat_id_cs' ELSE 'telegram_chat_id_finance' END), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id CROSS JOIN (SELECT 'CS' AS division UNION ALL SELECT 'FINANCE') d WHERE b.id = ?2 AND b.stages_done = 4 ON CONFLICT(id) DO NOTHING;";

/**
 * Order menjadi siap kirim, ke grup Production (v3.3, keputusan H). Memuat
 * `BATCH_LIST_SQL` utuh (dites di `notification.test.ts`); ?1 = id tagihan yang baru
 * dibuat, dibatalkan, atau dialokasikan. Hanya menulis bila order tiket itu
 * siap kirim menurut aturan `shipGateError`; `id` = sekali per work order.
 */
export const NOTIFY_SHIP_CLEARED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'ship-cleared:' || z.id, 'SHIP_CLEARED', 'PRODUCTION', json_object('sample_id', z.sample_request_id, 'client_code', COALESCE(z.client_code, ''), 'client_name', COALESCE(z.client_name, ''), 'brand_name', z.brand_name, 'batch_code', z.batch_code, 'carton_count', z.carton_count), datetime('now'), CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_production'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM (SELECT b.*, CASE WHEN b.stages_done < 4 OR b.packed_at = '' THEN 0 ELSE MAX(0, CAST(julianday(CASE WHEN b.settlement_count > 0 AND b.settlement_unpaid = 0 AND b.settlement_paid_on <> '' THEN b.settlement_paid_on ELSE date('now', b.tz_shift) END) - julianday(date(b.packed_at, b.tz_shift)) AS INTEGER) - b.storage_grace_days) END AS storage_days FROM (SELECT b.*, m.mou_number, m.total_units, m.regulatory_path, m.production_lead_time_days, s.brand_name, c.client_code, c.name AS client_name, (SELECT COUNT(*) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS open_orders, (SELECT MIN(p.eta_on) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS next_eta_on, CASE m.regulatory_path WHEN 'WITH_BPOM' THEN 4 ELSE 1 END - (SELECT COUNT(DISTINCT l.kind) FROM legal_documents l WHERE l.mou_id = b.mou_id AND l.status IN ('ISSUED', 'NOT_REQUIRED') AND (m.regulatory_path = 'WITH_BPOM' OR l.kind = 'HALAL')) AS legal_open, s.ship_to_address, m.total_production_cost_idr, m.dp_amount_required_idr, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'SETTLEMENT' AND i.status <> 'CANCELLED') AS settlement_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'STORAGE_FEE' AND i.status <> 'CANCELLED') AS storage_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS settlement_unpaid, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) IN ('SETTLEMENT', 'SHIPPING', 'STORAGE_FEE') AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS ship_unpaid, COALESCE((SELECT MAX(f.received_on) FROM invoices i JOIN fund_allocations a ON a.invoice_id = i.id JOIN incoming_funds f ON f.id = a.fund_id WHERE i.sample_request_id = b.sample_request_id AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT'), '') AS settlement_paid_on, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_grace_days'), 14) AS storage_grace_days, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_fee_idr'), 0) AS storage_rate_idr, CASE COALESCE((SELECT z.timezone FROM company_profile z WHERE z.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz_shift FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id) b) z WHERE z.sample_request_id = (SELECT i.sample_request_id FROM invoices i WHERE i.id = ?1) AND z.stages_done = 4 AND z.settlement_count > 0 AND z.ship_unpaid = 0 AND (z.storage_days * z.carton_count * z.storage_rate_idr = 0 OR z.storage_count > 0) ON CONFLICT(id) DO NOTHING;";

/**
 * Barang keluar, ke grup CS (v3.4, keputusan H): CS meneruskan resi dan Surat
 * Jalan ke klien. ?1 = id log langkah, ?2 = id pengiriman.
 */
export const NOTIFY_SHIPPED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'shipped:' || ?1, 'SHIPMENT_SHIPPED', 'CS', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'delivery_note_no', h.delivery_note_no, 'method', h.method, 'carrier', COALESCE(o.label, ''), 'tracking_no', h.tracking_no, 'driver_name', h.driver_name, 'vehicle_plate', h.vehicle_plate), h.shipped_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM shipments h JOIN sample_requests s ON s.id = h.sample_request_id LEFT JOIN clients c ON c.id = h.client_id LEFT JOIN master_option o ON o.id = h.carrier_option_id WHERE h.id = ?2 AND h.status = 'SHIPPED' LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/** Jadwal produksi disimpan, ke grup CS (v3.1). ?1 = id log, ?2 = id work order. */
export const NOTIFY_BATCH_SCHEDULED_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'schedule:' || ?1, 'BATCH_SCHEDULED', 'CS', json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'batch_code', b.batch_code, 'packing_on', b.sched_packing_on, 'notes', COALESCE(l.notes, '')), b.schedule_updated_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM production_batches b JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id LEFT JOIN sample_status_log l ON l.id = ?1 WHERE b.id = ?2 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

/** Ringkasan Cold yang sudah ada untuk satu tanggal, dan tanggal ringkasan terakhir. */
export const COLD_DIGEST_STATE_SQL =
  "SELECT (SELECT COUNT(*) FROM notification_outbox WHERE id = ?1) AS done, COALESCE((SELECT MAX(id) FROM notification_outbox WHERE id LIKE 'cold-digest:%'), '') AS last_id;";

/** ?1/?2 = rentang `coldDigestWindow`. */
export const COLD_DIGEST_LEADS_SQL =
  "SELECT c.client_code, c.name AS client_name, COALESCE(o.nama_operator, '') AS pic FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at >= ?1 AND l.last_client_response_at < ?2 ORDER BY l.last_client_response_at, c.client_code LIMIT 50;";

/** ?1 = id, ?2 = payload, ?3 = status (`PENDING`/`SKIPPED`). */
export const COLD_DIGEST_INSERT_SQL =
  "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) VALUES (?1, 'COLD_DIGEST', 'CS', ?2, datetime('now'), ?3, 0, datetime('now'), datetime('now')) ON CONFLICT(id) DO NOTHING;";

export const NOTIFICATION_DUE_SQL =
  "SELECT id, event_type, target_division, payload_json, occurred_at, attempts FROM notification_outbox WHERE status = 'PENDING' AND next_attempt_at <= datetime('now') AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes')) ORDER BY created_at, rowid LIMIT 10;";

/** Satu pemenang per baris: dua pengirim yang berlomba hanya satu yang mendapat rowsAffected = 1. */
export const NOTIFICATION_CLAIM_SQL =
  "UPDATE notification_outbox SET claimed_at = datetime('now'), attempts = attempts + 1 WHERE id = ?1 AND status = 'PENDING' AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes'));";

export const NOTIFICATION_SENT_SQL =
  "UPDATE notification_outbox SET status = 'SENT', sent_at = datetime('now'), claimed_at = NULL, last_error = '' WHERE id = ?1;";

/** Chat ID divisinya dikosongkan setelah baris lahir. */
export const NOTIFICATION_SKIP_SQL =
  "UPDATE notification_outbox SET status = 'SKIPPED', claimed_at = NULL WHERE id = ?1;";

/** ?2 = error dari Telegram, ?3 = jeda menit (`null` = berhenti, `FAILED`). */
export const NOTIFICATION_FAILED_SQL =
  "UPDATE notification_outbox SET status = CASE WHEN ?3 IS NULL THEN 'FAILED' ELSE status END, claimed_at = NULL, last_error = ?2, next_attempt_at = CASE WHEN ?3 IS NULL THEN next_attempt_at ELSE datetime('now', '+' || ?3 || ' minutes') END WHERE id = ?1;";

export const NOTIFICATION_RETRY_FAILED_SQL =
  "UPDATE notification_outbox SET status = 'PENDING', attempts = 0, claimed_at = NULL, next_attempt_at = datetime('now') WHERE status = 'FAILED';";

export const NOTIFICATION_FAILED_LIST_SQL =
  "SELECT id, event_type, target_division, occurred_at, attempts, last_error FROM notification_outbox WHERE status = 'FAILED' ORDER BY created_at DESC, rowid DESC LIMIT 50;";

export const NOTIFICATION_PENDING_COUNT_SQL =
  "SELECT COUNT(*) AS total FROM notification_outbox WHERE status = 'PENDING';";

/**
 * Lonceng: ?1-?5 = boleh melihat CS/RnD/Finance/Desain/Production (0/1). Ringkasan Cold
 * kosong hanya penanda tanggal, tidak pernah ditampilkan.
 */
export const NOTIFICATION_BELL_LIST_SQL =
  "SELECT id, event_type, target_division, payload_json, occurred_at, created_at FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE') OR (?4 = 1 AND target_division = 'DESIGN') OR (?5 = 1 AND target_division = 'PRODUCTION')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) ORDER BY created_at DESC, rowid DESC LIMIT 30;";

/** ?6 = operator id. Belum dibaca = lahir sesudah operator terakhir membuka lonceng. */
export const NOTIFICATION_UNREAD_COUNT_SQL =
  "SELECT COUNT(*) AS total FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE') OR (?4 = 1 AND target_division = 'DESIGN') OR (?5 = 1 AND target_division = 'PRODUCTION')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) AND created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE operator_id = ?6), '');";

/** Waktu database, zona perusahaan, dan konfigurasi bot dalam satu baris. */
export const NOTIFICATION_CONTEXT_SQL =
  "SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now_epoch, COALESCE((SELECT timezone FROM company_profile WHERE id = 'default_company'), '') AS timezone, COALESCE((SELECT is_active FROM telegram_config WHERE id = 'default'), 0) AS is_active, COALESCE((SELECT bot_token FROM telegram_config WHERE id = 'default'), '') AS bot_token, COALESCE((SELECT updated_at FROM telegram_config WHERE id = 'default'), '') AS updated_at, COALESCE((SELECT updated_by FROM telegram_config WHERE id = 'default'), '') AS updated_by;";

/** Kunci setelan bisnis yang dibutuhkan pengirim (dibaca lewat `readBusinessSettings`). */
export const NOTIFICATION_SETTINGS_SQL =
  "SELECT key, value FROM setting_gex_system WHERE key IN ('lead_hot_max_days', 'lead_warm_max_days', 'telegram_chat_id_cs', 'telegram_chat_id_rnd', 'telegram_chat_id_finance', 'telegram_chat_id_design', 'telegram_chat_id_production');";

/** ?1 = token baru (kosong = pertahankan yang lama, aturan 11), ?2 = aktif, ?3 = pelaku. */
export const TELEGRAM_CONFIG_SAVE_SQL =
  "INSERT INTO telegram_config (id, bot_token, is_active, updated_at, updated_by) VALUES ('default', ?1, ?2, datetime('now'), ?3) ON CONFLICT(id) DO UPDATE SET bot_token = CASE WHEN excluded.bot_token = '' THEN telegram_config.bot_token ELSE excluded.bot_token END, is_active = excluded.is_active, updated_at = excluded.updated_at, updated_by = excluded.updated_by;";

export const NOTIFICATION_MARK_SEEN_SQL =
  "INSERT INTO notification_seen (operator_id, seen_at) VALUES (?1, datetime('now')) ON CONFLICT(operator_id) DO UPDATE SET seen_at = excluded.seen_at;";
