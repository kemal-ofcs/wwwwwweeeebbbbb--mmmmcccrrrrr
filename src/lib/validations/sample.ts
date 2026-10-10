/**
 * Aturan tiket sampel (PRD FR-06) dan setelan bisnis (FR-11) yang WAJIB identik
 * dengan `src-tauri/src/desktop/samples.rs`. Kedua sisi diuji dengan vektor
 * yang sama (`sample.test.ts` dan `mod tests` di `samples.rs`): tiket yang sama
 * harus berpindah ke status yang sama di Web dan di perangkat, termasuk saat
 * kuota revisi habis.
 */

// ---------------------------------------------------------------------------
// Setelan bisnis (FR-11). Disimpan di `setting_gex_system`, ikut sinkronisasi,
// diubah pemegang `settings.manage`. Nilai yang rusak jatuh ke bawaan.
// ---------------------------------------------------------------------------

export const SAMPLE_FEE_MODES = ["FREE", "PAID", "PER_REQUEST"] as const;
export type SampleFeeMode = (typeof SAMPLE_FEE_MODES)[number];

export const BUSINESS_SETTING_KEYS = {
  defaultFreeRevisionLimit: "default_free_revision_limit",
  sampleFeeMode: "sample_fee_mode",
  leadHotMaxDays: "lead_hot_max_days",
  leadWarmMaxDays: "lead_warm_max_days",
  maxPhotosPerSample: "max_photos_per_sample",
  telegramChatIdCs: "telegram_chat_id_cs",
  telegramChatIdRnd: "telegram_chat_id_rnd",
  telegramChatIdFinance: "telegram_chat_id_finance",
  offlineLoginMaxDays: "offline_login_max_days",
  defaultSampleFeeIdr: "default_sample_fee_idr",
  defaultTestFeeIdr: "default_test_fee_idr",
  invoiceDueDays: "invoice_due_days",
  invoicePaymentInstructions: "invoice_payment_instructions",
  telegramChatIdDesign: "telegram_chat_id_design",
  telegramChatIdProduction: "telegram_chat_id_production",
  defaultDummyFeeIdr: "default_dummy_fee_idr",
  maxDummyRejections: "max_dummy_rejections",
  dpPercentageBp: "dp_percentage_bp",
  approvalWebUrl: "approval_web_url",
  approvalTokenTtlDays: "approval_token_ttl_days",
} as const;

export interface BusinessSettings {
  default_free_revision_limit: number;
  sample_fee_mode: SampleFeeMode;
  lead_hot_max_days: number;
  lead_warm_max_days: number;
  /** Batas foto per tiket sampel (PRD F-07, keputusan B 1.4b). */
  max_photos_per_sample: number;
  /**
   * Grup Telegram per divisi (PRD FR-08, FR-11). Kosong = kejadian divisi itu
   * tidak dikirim ke Telegram (tetap tampil di lonceng aplikasi).
   */
  telegram_chat_id_cs: string;
  telegram_chat_id_rnd: string;
  telegram_chat_id_finance: string;
  /**
   * Masa login offline Desktop/Mobile dalam hari, 1 sampai batas build
   * (`APP_OFFLINE_AUTH_MAX_AGE_HOURS`, 7 hari). Web tidak punya login offline.
   */
  offline_login_max_days: number;
  /**
   * Isian awal nominal tagihan biaya sampel dan uji (v2.3a, keputusan B);
   * 0 = kosong, Finance mengetik sendiri.
   */
  default_sample_fee_idr: number;
  default_test_fee_idr: number;
  /** Jatuh tempo tagihan = tanggal terbit + hari ini (keputusan L). */
  invoice_due_days: number;
  /** Teks bebas di invoice PDF: rekening, atas nama, catatan (v2.3c). */
  invoice_payment_instructions: string;
  /** Grup Telegram divisi Desain (v2.4, PRD F-19). */
  telegram_chat_id_design: string;
  /** Grup Telegram Production: PPIC, SPV, QC, Logistik (v3.1, D-43). */
  telegram_chat_id_production: string;
  /** Isian awal nominal tagihan dummy (v2.4); 0 = kosong. */
  default_dummy_fee_idr: number;
  /**
   * Batas penolakan dummy (D-18, OQ-29); 0 = tanpa batas. Sesudahnya cetak
   * ulang hanya oleh pemegang `design.override_dummy_limit`.
   */
  max_dummy_rejections: number;
  /** Persen DP bawaan MoU dalam basis poin (v2.5a, F-20); disalin ke MoU. */
  dp_percentage_bp: number;
  /**
   * Alamat Web untuk tautan persetujuan klien (v2.5b, F-18, keputusan K);
   * kosong = hanya jalur manual WhatsApp.
   */
  approval_web_url: string;
  /** Masa berlaku tautan persetujuan dalam hari (keputusan L). */
  approval_token_ttl_days: number;
}

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  default_free_revision_limit: 1,
  sample_fee_mode: "PER_REQUEST",
  lead_hot_max_days: 3,
  lead_warm_max_days: 7,
  max_photos_per_sample: 10,
  telegram_chat_id_cs: "",
  telegram_chat_id_rnd: "",
  telegram_chat_id_finance: "",
  offline_login_max_days: 7,
  default_sample_fee_idr: 0,
  default_test_fee_idr: 0,
  invoice_due_days: 7,
  invoice_payment_instructions: "",
  telegram_chat_id_design: "",
  telegram_chat_id_production: "",
  default_dummy_fee_idr: 0,
  max_dummy_rejections: 0,
  dp_percentage_bp: 5000,
  approval_web_url: "",
  approval_token_ttl_days: 3,
};

export const FREE_REVISION_LIMIT_MAX = 20;
export const LEAD_HOT_MAX_DAYS_LIMIT = 60;
export const LEAD_WARM_MAX_DAYS_LIMIT = 180;
export const MAX_PHOTOS_PER_SAMPLE_LIMIT = 50;
export const OFFLINE_LOGIN_MAX_DAYS_LIMIT = 7;
/** Sama dengan `INVOICE_AMOUNT_MAX` di `finance.ts`. */
export const DEFAULT_FEE_MAX = 100_000_000_000;
export const INVOICE_DUE_DAYS_LIMIT = 90;
export const PAYMENT_INSTRUCTIONS_MAX = 1000;
export const MAX_DUMMY_REJECTIONS_LIMIT = 20;
export const APPROVAL_TTL_DAYS_LIMIT = 30;
export const APPROVAL_WEB_URL_MAX = 200;
export const APPROVAL_WEB_URL_INVALID =
  "Enter the approval web address as https://..., or leave it empty.";
export const APPROVAL_TTL_INVALID =
  "Approval links must last a whole number of days from 1 to 30.";

/**
 * Alamat Web tautan persetujuan: kosong, atau `https://host[:port][/path]`
 * tanpa garis miring penutup. `null` = tidak sah. Diperiksa per karakter
 * (bukan regex) supaya identik dengan `normalize_approval_web_url`.
 */
export function normalizeApprovalWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  while (text.endsWith("/")) text = text.slice(0, -1);
  if (text === "") return "";
  if (text.length > APPROVAL_WEB_URL_MAX || !text.startsWith("https://")) {
    return null;
  }
  const rest = text.slice("https://".length);
  const slash = rest.indexOf("/");
  const hostPort = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  const [host = "", port, extra] = hostPort.split(":");
  const hostOk =
    host !== "" && [...host].every((char) => /[A-Za-z0-9.-]/.test(char));
  const portOk =
    port === undefined ||
    (port.length >= 1 &&
      port.length <= 5 &&
      [...port].every((char) => char >= "0" && char <= "9"));
  const pathOk = [...path].every((char) => /[A-Za-z0-9._~/-]/.test(char));
  return hostOk && portOk && extra === undefined && pathOk ? text : null;
}

export const DP_PERCENTAGE_INVALID =
  "The down payment must be from 0.01% to 100%.";
export const PAYMENT_INSTRUCTIONS_INVALID =
  "Payment instructions are up to 1000 characters.";

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string" && /^\d{1,12}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak. */
function strictInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function inRange(value: number | null, min: number, max: number) {
  return value !== null && value >= min && value <= max ? value : null;
}

/**
 * Chat ID Telegram: kosong, angka (grup bernilai negatif, mis.
 * `-1001234567890`), atau `@nama_channel`. `null` = tidak sah. Padanan
 * `normalize_telegram_chat_id` di `samples.rs`.
 */
export function normalizeTelegramChatId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return "";
  return /^-?\d{1,20}$/.test(text) || /^@[A-Za-z0-9_]{5,32}$/.test(text)
    ? text
    : null;
}

export const TELEGRAM_CHAT_ID_INVALID =
  "Enter a Telegram chat ID such as -1001234567890 or @channel_name, or leave it empty.";

/**
 * Baca setelan dari baris `setting_gex_system` (kunci → teks). Nilai yang
 * hilang atau rusak jatuh ke bawaan, satu per satu; batas Warm yang tidak
 * lebih besar dari Hot membuat keduanya kembali ke bawaan.
 */
export function readBusinessSettings(
  values: Record<string, string | undefined>,
): BusinessSettings {
  const limit = inRange(
    wholeNumber(values[BUSINESS_SETTING_KEYS.defaultFreeRevisionLimit]),
    0,
    FREE_REVISION_LIMIT_MAX,
  );
  const mode = values[BUSINESS_SETTING_KEYS.sampleFeeMode]?.trim() ?? "";
  let hot = inRange(
    wholeNumber(values[BUSINESS_SETTING_KEYS.leadHotMaxDays]),
    0,
    LEAD_HOT_MAX_DAYS_LIMIT,
  );
  let warm = inRange(
    wholeNumber(values[BUSINESS_SETTING_KEYS.leadWarmMaxDays]),
    1,
    LEAD_WARM_MAX_DAYS_LIMIT,
  );
  if (hot === null || warm === null || warm <= hot) {
    hot = DEFAULT_BUSINESS_SETTINGS.lead_hot_max_days;
    warm = DEFAULT_BUSINESS_SETTINGS.lead_warm_max_days;
  }
  return {
    default_free_revision_limit:
      limit ?? DEFAULT_BUSINESS_SETTINGS.default_free_revision_limit,
    sample_fee_mode: (SAMPLE_FEE_MODES as readonly string[]).includes(mode)
      ? (mode as SampleFeeMode)
      : DEFAULT_BUSINESS_SETTINGS.sample_fee_mode,
    lead_hot_max_days: hot,
    lead_warm_max_days: warm,
    max_photos_per_sample:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.maxPhotosPerSample]),
        1,
        MAX_PHOTOS_PER_SAMPLE_LIMIT,
      ) ?? DEFAULT_BUSINESS_SETTINGS.max_photos_per_sample,
    telegram_chat_id_cs:
      normalizeTelegramChatId(values[BUSINESS_SETTING_KEYS.telegramChatIdCs]) ??
      "",
    telegram_chat_id_rnd:
      normalizeTelegramChatId(
        values[BUSINESS_SETTING_KEYS.telegramChatIdRnd],
      ) ?? "",
    telegram_chat_id_finance:
      normalizeTelegramChatId(
        values[BUSINESS_SETTING_KEYS.telegramChatIdFinance],
      ) ?? "",
    offline_login_max_days:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.offlineLoginMaxDays]),
        1,
        OFFLINE_LOGIN_MAX_DAYS_LIMIT,
      ) ?? DEFAULT_BUSINESS_SETTINGS.offline_login_max_days,
    default_sample_fee_idr:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.defaultSampleFeeIdr]),
        0,
        DEFAULT_FEE_MAX,
      ) ?? DEFAULT_BUSINESS_SETTINGS.default_sample_fee_idr,
    default_test_fee_idr:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.defaultTestFeeIdr]),
        0,
        DEFAULT_FEE_MAX,
      ) ?? DEFAULT_BUSINESS_SETTINGS.default_test_fee_idr,
    invoice_due_days:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.invoiceDueDays]),
        0,
        INVOICE_DUE_DAYS_LIMIT,
      ) ?? DEFAULT_BUSINESS_SETTINGS.invoice_due_days,
    invoice_payment_instructions: storedInstructions(
      values[BUSINESS_SETTING_KEYS.invoicePaymentInstructions],
    ),
    telegram_chat_id_design:
      normalizeTelegramChatId(
        values[BUSINESS_SETTING_KEYS.telegramChatIdDesign],
      ) ?? "",
    telegram_chat_id_production:
      normalizeTelegramChatId(
        values[BUSINESS_SETTING_KEYS.telegramChatIdProduction],
      ) ?? "",
    default_dummy_fee_idr:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.defaultDummyFeeIdr]),
        0,
        DEFAULT_FEE_MAX,
      ) ?? DEFAULT_BUSINESS_SETTINGS.default_dummy_fee_idr,
    max_dummy_rejections:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.maxDummyRejections]),
        0,
        MAX_DUMMY_REJECTIONS_LIMIT,
      ) ?? DEFAULT_BUSINESS_SETTINGS.max_dummy_rejections,
    dp_percentage_bp:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.dpPercentageBp]),
        1,
        10_000,
      ) ?? DEFAULT_BUSINESS_SETTINGS.dp_percentage_bp,
    approval_web_url:
      normalizeApprovalWebUrl(values[BUSINESS_SETTING_KEYS.approvalWebUrl]) ??
      "",
    approval_token_ttl_days:
      inRange(
        wholeNumber(values[BUSINESS_SETTING_KEYS.approvalTokenTtlDays]),
        1,
        APPROVAL_TTL_DAYS_LIMIT,
      ) ?? DEFAULT_BUSINESS_SETTINGS.approval_token_ttl_days,
  };
}

/** Teks tersimpan yang terlalu panjang dianggap rusak dan jatuh ke kosong. */
function storedInstructions(value: string | undefined) {
  const text = (value ?? "").trim();
  return [...text].length <= PAYMENT_INSTRUCTIONS_MAX ? text : "";
}

/** Validasi form Pengaturan. Pesan identik dengan `validate_business_settings`. */
export function validateBusinessSettings(
  draft: Record<string, unknown>,
): { settings: BusinessSettings } | { error: string } {
  const limit = inRange(
    strictInt(draft.default_free_revision_limit),
    0,
    FREE_REVISION_LIMIT_MAX,
  );
  if (limit === null) {
    return { error: "Free revisions must be a whole number from 0 to 20." };
  }
  const mode = draft.sample_fee_mode;
  if (
    typeof mode !== "string" ||
    !(SAMPLE_FEE_MODES as readonly string[]).includes(mode)
  ) {
    return { error: "Choose how sample fees are charged." };
  }
  const hot = inRange(
    strictInt(draft.lead_hot_max_days),
    0,
    LEAD_HOT_MAX_DAYS_LIMIT,
  );
  if (hot === null) {
    return {
      error: "The Hot limit must be a whole number of days from 0 to 60.",
    };
  }
  const warm = inRange(
    strictInt(draft.lead_warm_max_days),
    1,
    LEAD_WARM_MAX_DAYS_LIMIT,
  );
  if (warm === null || warm <= hot) {
    return {
      error: "The Warm limit must be more days than the Hot limit, up to 180.",
    };
  }
  const photos = inRange(
    strictInt(draft.max_photos_per_sample),
    1,
    MAX_PHOTOS_PER_SAMPLE_LIMIT,
  );
  if (photos === null) {
    return {
      error: "Photos per sample request must be a whole number from 1 to 50.",
    };
  }
  // Wajib dikirim, walau kosong: field yang hilang dari draft akan menimpa
  // chat ID tersimpan dengan kosong.
  const chatCs = normalizeTelegramChatId(draft.telegram_chat_id_cs);
  const chatRnd = normalizeTelegramChatId(draft.telegram_chat_id_rnd);
  const chatFinance = normalizeTelegramChatId(draft.telegram_chat_id_finance);
  const chatDesign = normalizeTelegramChatId(draft.telegram_chat_id_design);
  const chatProduction = normalizeTelegramChatId(
    draft.telegram_chat_id_production,
  );
  if (
    chatCs === null ||
    chatRnd === null ||
    chatFinance === null ||
    chatDesign === null ||
    chatProduction === null
  ) {
    return { error: TELEGRAM_CHAT_ID_INVALID };
  }
  const offlineDays = inRange(
    strictInt(draft.offline_login_max_days),
    1,
    OFFLINE_LOGIN_MAX_DAYS_LIMIT,
  );
  if (offlineDays === null) {
    return {
      error:
        "The offline sign-in period must be a whole number of days from 1 to 7.",
    };
  }
  const sampleFee = inRange(
    strictInt(draft.default_sample_fee_idr),
    0,
    DEFAULT_FEE_MAX,
  );
  const testFee = inRange(
    strictInt(draft.default_test_fee_idr),
    0,
    DEFAULT_FEE_MAX,
  );
  const dummyFee = inRange(
    strictInt(draft.default_dummy_fee_idr),
    0,
    DEFAULT_FEE_MAX,
  );
  if (sampleFee === null || testFee === null || dummyFee === null) {
    return { error: "Default fees must be whole rupiah amounts." };
  }
  const dueDays = inRange(
    strictInt(draft.invoice_due_days),
    0,
    INVOICE_DUE_DAYS_LIMIT,
  );
  if (dueDays === null) {
    return {
      error:
        "The invoice due period must be a whole number of days from 0 to 90.",
    };
  }
  // Wajib dikirim, walau kosong: field yang hilang akan menimpa teks tersimpan.
  const instructions =
    typeof draft.invoice_payment_instructions === "string"
      ? draft.invoice_payment_instructions.trim()
      : null;
  if (
    instructions === null ||
    [...instructions].length > PAYMENT_INSTRUCTIONS_MAX
  ) {
    return { error: PAYMENT_INSTRUCTIONS_INVALID };
  }
  const dummyLimit = inRange(
    strictInt(draft.max_dummy_rejections),
    0,
    MAX_DUMMY_REJECTIONS_LIMIT,
  );
  if (dummyLimit === null) {
    return {
      error: "The dummy rejection limit must be a whole number from 0 to 20.",
    };
  }
  const dpBp = inRange(strictInt(draft.dp_percentage_bp), 1, 10_000);
  if (dpBp === null) return { error: DP_PERCENTAGE_INVALID };
  // Wajib dikirim, walau kosong: field yang hilang akan menimpa alamat tersimpan.
  const approvalUrl = normalizeApprovalWebUrl(draft.approval_web_url);
  if (approvalUrl === null) return { error: APPROVAL_WEB_URL_INVALID };
  const ttl = inRange(
    strictInt(draft.approval_token_ttl_days),
    1,
    APPROVAL_TTL_DAYS_LIMIT,
  );
  if (ttl === null) return { error: APPROVAL_TTL_INVALID };
  return {
    settings: {
      default_free_revision_limit: limit,
      sample_fee_mode: mode as SampleFeeMode,
      lead_hot_max_days: hot,
      lead_warm_max_days: warm,
      max_photos_per_sample: photos,
      telegram_chat_id_cs: chatCs,
      telegram_chat_id_rnd: chatRnd,
      telegram_chat_id_finance: chatFinance,
      offline_login_max_days: offlineDays,
      default_sample_fee_idr: sampleFee,
      default_test_fee_idr: testFee,
      invoice_due_days: dueDays,
      invoice_payment_instructions: instructions,
      telegram_chat_id_design: chatDesign,
      telegram_chat_id_production: chatProduction,
      default_dummy_fee_idr: dummyFee,
      max_dummy_rejections: dummyLimit,
      dp_percentage_bp: dpBp,
      approval_web_url: approvalUrl,
      approval_token_ttl_days: ttl,
    },
  };
}

// ---------------------------------------------------------------------------
// Status dan aksi tiket (FR-06.4, keputusan F).
// ---------------------------------------------------------------------------

export const SAMPLE_STATUSES = [
  "DRAFT",
  "RND_REVIEW",
  "RND_REJECTED",
  "RND_ACCEPTED",
  "WAITING_SAMPLE_PAYMENT",
  "IN_RND",
  "SAMPLE_READY",
  "SAMPLE_SENT",
  "CLIENT_ACC",
  "CLIENT_REJECT",
  "PENDING_FEE_ASSESSMENT",
  "WAITING_REVISION_PAYMENT",
  "CANCELLED",
] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

/** Tiket berhenti di sini; tidak ada aksi lanjutan. */
export const SAMPLE_TERMINAL_STATUSES: readonly SampleStatus[] = [
  "RND_REJECTED",
  "CLIENT_ACC",
  "CLIENT_REJECT",
  "CANCELLED",
];

export const SAMPLE_ACTIONS = [
  "SUBMIT_TO_RND",
  "RND_ACCEPT",
  "RND_REJECT",
  "PROCEED",
  "PAYMENT_RECEIVED",
  "SAMPLE_READY",
  "SAMPLE_SENT",
  "CLIENT_ACC",
  "CLIENT_REVISE",
  "CLIENT_REJECT",
  "CANCEL",
  // Finance menetapkan tarif revisi di luar kuota (v2.2, PRD F-15).
  "SET_REVISION_FEE",
] as const;
export type SampleAction = (typeof SAMPLE_ACTIONS)[number];

/**
 * Divisi yang sebenarnya mengambil keputusan. Di MVP CS mencatatnya atas nama
 * divisi itu (D-23); `null` = dicatat atas nama role pelaku sendiri.
 */
export const SAMPLE_ACTION_DIVISION: Record<SampleAction, string | null> = {
  SUBMIT_TO_RND: null,
  RND_ACCEPT: "RnD",
  RND_REJECT: "RnD",
  PROCEED: null,
  PAYMENT_RECEIVED: "Finance",
  SAMPLE_READY: "RnD",
  SAMPLE_SENT: null,
  CLIENT_ACC: null,
  CLIENT_REVISE: null,
  CLIENT_REJECT: null,
  CANCEL: null,
  SET_REVISION_FEE: "Finance",
};

/**
 * Izin yang dituntut tiap langkah. Langkah RnD milik `rnd.manage` (v2.1, PRD
 * F-14), langkah Finance milik `finance.manage` (v2.2, F-15), sisanya
 * `samples.manage`. Padanan `sample_action_permission` di Rust.
 */
export function sampleActionPermission(
  action: unknown,
): "rnd.manage" | "finance.manage" | "samples.manage" {
  if (
    action === "RND_ACCEPT" ||
    action === "RND_REJECT" ||
    action === "SAMPLE_READY"
  ) {
    return "rnd.manage";
  }
  return action === "PAYMENT_RECEIVED" || action === "SET_REVISION_FEE"
    ? "finance.manage"
    : "samples.manage";
}

export const SAMPLE_NOTES_MAX = 1000;
export const RND_LEAD_TIME_MAX_DAYS = 365;

export interface SampleActionState {
  status: string;
  is_paid_sample: boolean;
  revision_index: number;
  free_revision_limit: number;
  /** Iterasi yang sedang berjalan sudah diberi harga Finance (D-27). */
  has_price: boolean;
  /** Tagihan biaya sampel/revisi yang sedang ditunggu sudah lunas (v2.3a). */
  fee_paid: boolean;
  /** Tidak diminta uji, atau tagihan uji sudah lunas (D-30). */
  test_ready: boolean;
  /**
   * Tiket tidak butuh mockup, atau mockup sudah diunggah (v2.4, D-36):
   * mockup wajib bila tiket punya tiket desain aktif atau meminta dummy.
   */
  mockup_ready: boolean;
}

export interface SampleActionResult {
  status: SampleStatus;
  revision_index: number;
  /** `null` = tidak berubah. */
  is_billable: boolean | null;
  /** Keputusan klien untuk `sample_feedbacks`, bila aksi ini keputusan klien. */
  client_decision: "ACC" | "REVISE" | "REJECT" | null;
}

export const SAMPLE_STEP_NOT_ALLOWED =
  "This step is not allowed from the current status.";
export const SAMPLE_NOT_PRICED = "Finance has not priced this sample yet.";
export const SAMPLE_FEE_UNPAID =
  "Record the payment on this sample's invoice first.";
export const SAMPLE_TEST_UNPAID =
  "The testing fee for this sample is not paid yet.";
export const SAMPLE_MOCKUP_MISSING =
  "Upload the mockup before sending the sample.";
export const REVISION_FEE_INVALID =
  "Enter the revision fee in whole rupiah (0 waives it).";

export function isSampleAction(value: unknown): value is SampleAction {
  return (
    typeof value === "string" &&
    (SAMPLE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Satu langkah tiket. Seluruh diagram FR-06.4 ada di sini; langkah yang tidak
 * ada di diagram ditolak. `CLIENT_REVISE` langsung melewati gerbang kuota
 * (FR-06.5): revisi ke-n gratis selama n ≤ kuota klien. `SAMPLE_SENT` menunggu
 * harga Finance (D-27); `SET_REVISION_FEE` 0 = revisi dibebaskan Finance.
 */
export function applySampleAction(
  state: SampleActionState,
  action: SampleAction,
  leadTimeDays: number | null,
  revisionFeeIdr: number | null = null,
): SampleActionResult | { error: string } {
  const step = (
    from: readonly string[],
    status: SampleStatus,
  ): SampleActionResult | { error: string } =>
    from.includes(state.status)
      ? {
          status,
          revision_index: state.revision_index,
          is_billable: null,
          client_decision: null,
        }
      : { error: SAMPLE_STEP_NOT_ALLOWED };

  switch (action) {
    case "SUBMIT_TO_RND":
      return step(["DRAFT"], "RND_REVIEW");
    case "RND_ACCEPT": {
      if (state.status !== "RND_REVIEW")
        return { error: SAMPLE_STEP_NOT_ALLOWED };
      if (
        leadTimeDays === null ||
        !Number.isSafeInteger(leadTimeDays) ||
        leadTimeDays < 1 ||
        leadTimeDays > RND_LEAD_TIME_MAX_DAYS
      ) {
        return { error: "Enter the RnD lead time in days (1-365)." };
      }
      return step(["RND_REVIEW"], "RND_ACCEPTED");
    }
    case "RND_REJECT":
      return step(["RND_REVIEW"], "RND_REJECTED");
    case "PROCEED":
      return step(
        ["RND_ACCEPTED"],
        state.is_paid_sample ? "WAITING_SAMPLE_PAYMENT" : "IN_RND",
      );
    case "PAYMENT_RECEIVED": {
      const result = step(
        ["WAITING_SAMPLE_PAYMENT", "WAITING_REVISION_PAYMENT"],
        "IN_RND",
      );
      return "error" in result || state.fee_paid
        ? result
        : { error: SAMPLE_FEE_UNPAID };
    }
    case "SAMPLE_READY":
      return step(["IN_RND"], "SAMPLE_READY");
    case "SAMPLE_SENT":
      if (state.status === "SAMPLE_READY" && !state.has_price) {
        return { error: SAMPLE_NOT_PRICED };
      }
      if (state.status === "SAMPLE_READY" && !state.test_ready) {
        return { error: SAMPLE_TEST_UNPAID };
      }
      if (state.status === "SAMPLE_READY" && !state.mockup_ready) {
        return { error: SAMPLE_MOCKUP_MISSING };
      }
      return step(["SAMPLE_READY"], "SAMPLE_SENT");
    case "SET_REVISION_FEE": {
      if (state.status !== "PENDING_FEE_ASSESSMENT")
        return { error: SAMPLE_STEP_NOT_ALLOWED };
      if (
        revisionFeeIdr === null ||
        !Number.isSafeInteger(revisionFeeIdr) ||
        revisionFeeIdr < 0 ||
        revisionFeeIdr > SAMPLE_BUDGET_MAX
      ) {
        return { error: REVISION_FEE_INVALID };
      }
      return revisionFeeIdr === 0
        ? {
            status: "IN_RND",
            revision_index: state.revision_index,
            is_billable: false,
            client_decision: null,
          }
        : {
            status: "WAITING_REVISION_PAYMENT",
            revision_index: state.revision_index,
            is_billable: null,
            client_decision: null,
          };
    }
    case "CLIENT_ACC": {
      const result = step(["SAMPLE_SENT"], "CLIENT_ACC");
      return "error" in result ? result : { ...result, client_decision: "ACC" };
    }
    case "CLIENT_REJECT": {
      const result = step(["SAMPLE_SENT"], "CLIENT_REJECT");
      return "error" in result
        ? result
        : { ...result, client_decision: "REJECT" };
    }
    case "CLIENT_REVISE": {
      if (state.status !== "SAMPLE_SENT")
        return { error: SAMPLE_STEP_NOT_ALLOWED };
      const index = state.revision_index + 1;
      const free = index <= state.free_revision_limit;
      return {
        status: free ? "IN_RND" : "PENDING_FEE_ASSESSMENT",
        revision_index: index,
        is_billable: !free,
        client_decision: "REVISE",
      };
    }
    case "CANCEL":
      return SAMPLE_TERMINAL_STATUSES.includes(state.status as SampleStatus) ||
        !(SAMPLE_STATUSES as readonly string[]).includes(state.status)
        ? { error: SAMPLE_STEP_NOT_ALLOWED }
        : {
            status: "CANCELLED",
            revision_index: state.revision_index,
            is_billable: null,
            client_decision: null,
          };
  }
}

/** Catatan wajib di setiap langkah (FR-06.6). */
export function normalizeSampleNotes(value: unknown): string | null {
  const notes = typeof value === "string" ? value.trim() : "";
  return notes && [...notes].length <= SAMPLE_NOTES_MAX ? notes : null;
}

// ---------------------------------------------------------------------------
// Isian langkah RnD (v2.1, PRD F-14). Keputusan diterima/ditolak dan formula.
// ---------------------------------------------------------------------------

export const RND_PRODUCT_CLASSES = ["NEW", "EXISTING"] as const;
export type RndProductClass = (typeof RND_PRODUCT_CLASSES)[number];
export const FORMULA_CODE_MAX = 60;
export const PRODUCT_KNOWLEDGE_MAX = 2000;

/** `null` = langkah ini tidak mengubah kolom itu. */
export interface RndStep {
  product_class: RndProductClass | null;
  reject_reason_option_id: string | null;
  formula_code: string | null;
  product_knowledge: string | null;
}

const NO_RND_CHANGE: RndStep = {
  product_class: null,
  reject_reason_option_id: null,
  formula_code: null,
  product_knowledge: null,
};

/**
 * Accept wajib klasifikasi New/Existing; Reject wajib alasan (klasifikasi
 * boleh kosong, RnD bisa menolak sebelum sempat mengklasifikasi); Sample ready
 * wajib formula code dan product knowledge. Langkah lain mengabaikan isian.
 * Keberadaan alasan di Master Data diperiksa pemanggil. Pesan identik dengan
 * `validate_rnd_step` di Rust.
 */
export function validateRndStep(
  action: string,
  input: unknown,
): { rnd: RndStep } | { error: string } {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const classText = text(raw, "product_class");
  const productClass = (RND_PRODUCT_CLASSES as readonly string[]).includes(
    classText,
  )
    ? (classText as RndProductClass)
    : null;
  switch (action) {
    case "RND_ACCEPT":
      if (!productClass) {
        return {
          error: "Choose whether this is a new or an existing product.",
        };
      }
      return { rnd: { ...NO_RND_CHANGE, product_class: productClass } };
    case "RND_REJECT": {
      if (classText && !productClass) {
        return {
          error: "Choose whether this is a new or an existing product.",
        };
      }
      const reason = text(raw, "reject_reason_option_id");
      if (!reason) {
        return { error: "Choose the reason RnD rejected the request." };
      }
      return {
        rnd: {
          ...NO_RND_CHANGE,
          product_class: productClass,
          reject_reason_option_id: reason,
        },
      };
    }
    case "SAMPLE_READY": {
      const code = text(raw, "formula_code");
      if (!code || length(code) > FORMULA_CODE_MAX) {
        return { error: "Enter the formula code, up to 60 characters." };
      }
      const knowledge = text(raw, "product_knowledge");
      if (!knowledge || length(knowledge) > PRODUCT_KNOWLEDGE_MAX) {
        return {
          error: "Enter the product knowledge, up to 2000 characters.",
        };
      }
      return {
        rnd: {
          ...NO_RND_CHANGE,
          formula_code: code,
          product_knowledge: knowledge,
        },
      };
    }
    default:
      return { rnd: NO_RND_CHANGE };
  }
}

// ---------------------------------------------------------------------------
// Harga satuan (v2.2, PRD F-16, D-16, D-27). Padanan `compute_unit_price`.
// ---------------------------------------------------------------------------

export const PRICE_COMPONENT_MAX = 1_000_000_000;
/** Margin atas harga jual, basis poin; 9500 = 95%. */
export const MARGIN_BP_MAX = 9500;

export interface UnitPrice {
  raw_material_cost_idr: number;
  packaging_cost_idr: number;
  operational_cost_idr: number;
  /** Komponen keempat, opsional (0): regulasi dan uji per unit. */
  regulatory_cost_idr: number;
  margin_bp: number;
  hpp_unit_idr: number;
  final_unit_price_idr: number;
  notes: string;
}

const PRICE_COMPONENTS = [
  "raw_material_cost_idr",
  "packaging_cost_idr",
  "operational_cost_idr",
  "regulatory_cost_idr",
] as const;

/**
 * HPP = jumlah empat komponen per unit; harga jual = HPP ÷ (1 − margin),
 * margin dihitung atas harga jual (mockup SCR-09: 19.500 dengan 40% =
 * 32.500), dibulatkan ke atas ke rupiah penuh (D-16). Bilangan bulat saja.
 */
export function computeUnitPrice(
  input: unknown,
): { price: UnitPrice } | { error: string } {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const costs: number[] = [];
  for (const key of PRICE_COMPONENTS) {
    const value = strictInt(raw[key]);
    if (value === null || value < 0 || value > PRICE_COMPONENT_MAX) {
      return { error: "Each cost must be a whole rupiah amount per unit." };
    }
    costs.push(value);
  }
  const hpp = costs.reduce((sum, value) => sum + value, 0);
  if (hpp < 1) return { error: "Enter at least one cost." };
  const margin = strictInt(raw.margin_bp);
  if (margin === null || margin < 0 || margin > MARGIN_BP_MAX) {
    return { error: "The margin must be from 0% to 95%." };
  }
  // Catatan opsional, mis. jumlah order yang menjadi dasar harga.
  const notes = text(raw, "notes");
  if (length(notes) > SAMPLE_NOTES_MAX) {
    return { error: "Notes are up to 1000 characters." };
  }
  // Pembagian bulat dibulatkan ke atas; hasil kali tetap di bawah 2^53.
  const divisor = 10_000 - margin;
  const scaled = hpp * 10_000;
  const floor = Math.floor(scaled / divisor);
  return {
    price: {
      raw_material_cost_idr: costs[0] ?? 0,
      packaging_cost_idr: costs[1] ?? 0,
      operational_cost_idr: costs[2] ?? 0,
      regulatory_cost_idr: costs[3] ?? 0,
      margin_bp: margin,
      hpp_unit_idr: hpp,
      final_unit_price_idr: floor * divisor < scaled ? floor + 1 : floor,
      notes,
    },
  };
}

/** `Rp 32.500`: dipakai pesan notifikasi, identik dengan `format_rupiah`. */
export function formatRupiah(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}Rp ${grouped}`;
}

// ---------------------------------------------------------------------------
// Draft tiket (FR-06.1, keputusan G dan M).
// ---------------------------------------------------------------------------

/** Field yang masih boleh diubah setelah tiket dikirim ke RnD (keputusan G). */
export const SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT = [
  "deadline_at",
  "ship_to_address",
  "pic_crm_id",
  "client_budget_idr",
] as const;

export const SAMPLE_QTY_MAX = 10_000;
export const SAMPLE_TEXT_MAX = 300;
export const SAMPLE_BRAND_MAX = 120;
export const SAMPLE_LONG_TEXT_MAX = 2000;
export const SAMPLE_BUDGET_MAX = 1_000_000_000_000;
export const SPECIAL_REQUEST_KEYS = [
  "color",
  "texture",
  "size",
  "aroma",
] as const;

export interface SampleDraft {
  product_category_option_id: string;
  sample_kind_option_id: string;
  formulation_type_option_id: string;
  registration_category_option_id: string;
  pic_crm_id: number | null;
  sample_qty: number;
  brand_name: string;
  bpom_product_name: string;
  claims: string;
  packaging: string;
  reference_notes: string;
  client_budget_idr: number | null;
  /** JSON berurutan tetap: `{"color","texture","size","aroma"}`. */
  special_requests_json: string;
  deadline_at: string;
  ship_to_address: string;
  is_dummy_required: boolean;
  is_paid_sample: boolean;
  /** Sampel sekalian diuji (D-30); hanya bisa diubah selama `DRAFT`. */
  is_test_requested: boolean;
}

function text(draft: Record<string, unknown>, key: string) {
  const value = draft[key];
  return typeof value === "string" ? value.trim() : "";
}

function length(value: string) {
  return [...value].length;
}

/** `YYYY-MM-DD` kalender yang benar-benar ada. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (year < 2000 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

/**
 * Rapikan dan periksa draft tiket. Keberadaan pilihan Master Data dan PIC CRM
 * diperiksa pemanggil terhadap database; di sini hanya bentuknya. Pesan
 * identik dengan `validate_sample_draft` di Rust.
 */
export function validateSampleDraft(
  draft: Record<string, unknown>,
  feeMode: SampleFeeMode,
): { draft: SampleDraft } | { error: string } {
  const productCategory = text(draft, "product_category_option_id");
  if (!productCategory) return { error: "Choose the product type." };

  const qty = strictInt(draft.sample_qty);
  if (qty === null || qty < 1 || qty > SAMPLE_QTY_MAX) {
    return { error: "Enter the sample quantity (1-10000)." };
  }
  const brand = text(draft, "brand_name");
  if (!brand || length(brand) > SAMPLE_BRAND_MAX) {
    return { error: "The brand name is required, up to 120 characters." };
  }
  const packaging = text(draft, "packaging");
  if (!packaging || length(packaging) > SAMPLE_TEXT_MAX) {
    return { error: "The packaging is required, up to 300 characters." };
  }
  const deadline = text(draft, "deadline_at");
  if (!isCalendarDate(deadline)) {
    return { error: "Enter the date the sample must reach the client." };
  }
  const address = text(draft, "ship_to_address");
  if (!address || length(address) > SAMPLE_TEXT_MAX) {
    return { error: "The shipping address is required, up to 300 characters." };
  }
  if (typeof draft.is_dummy_required !== "boolean") {
    return { error: "Choose whether a packaging dummy is needed." };
  }
  // Opsional: event lama yang belum membawa kunci ini berarti tanpa uji.
  const testing = draft.is_test_requested ?? false;
  if (typeof testing !== "boolean") {
    return { error: "Choose whether the sample is tested." };
  }

  const bpom = text(draft, "bpom_product_name");
  const claims = text(draft, "claims");
  const reference = text(draft, "reference_notes");
  if (
    length(bpom) > SAMPLE_BRAND_MAX ||
    length(claims) > SAMPLE_LONG_TEXT_MAX ||
    length(reference) > SAMPLE_LONG_TEXT_MAX
  ) {
    return { error: "One of the text fields is too long." };
  }

  const special: Record<string, string> = {};
  const rawSpecial =
    draft.special_requests && typeof draft.special_requests === "object"
      ? (draft.special_requests as Record<string, unknown>)
      : {};
  for (const key of SPECIAL_REQUEST_KEYS) {
    const value = text(rawSpecial, key);
    if (length(value) > SAMPLE_TEXT_MAX) {
      return { error: "Each special request is up to 300 characters." };
    }
    special[key] = value;
  }

  let budget: number | null = null;
  if (
    draft.client_budget_idr !== null &&
    draft.client_budget_idr !== undefined &&
    draft.client_budget_idr !== ""
  ) {
    budget = strictInt(draft.client_budget_idr);
    if (budget === null || budget < 0 || budget > SAMPLE_BUDGET_MAX) {
      return { error: "The client budget must be a whole rupiah amount." };
    }
  }

  let pic: number | null = null;
  if (
    draft.pic_crm_id !== null &&
    draft.pic_crm_id !== undefined &&
    draft.pic_crm_id !== 0
  ) {
    pic = strictInt(draft.pic_crm_id);
    if (pic === null || pic < 1)
      return { error: "Choose an active CRM operator." };
  }

  let paid: boolean;
  const requested = draft.is_paid_sample;
  if (feeMode === "PER_REQUEST") {
    if (typeof requested !== "boolean") {
      return { error: "Choose whether this sample is paid." };
    }
    paid = requested;
  } else {
    paid = feeMode === "PAID";
    if (typeof requested === "boolean" && requested !== paid) {
      return {
        error: paid
          ? "Company settings make every sample paid."
          : "Company settings make every sample free.",
      };
    }
  }

  return {
    draft: {
      product_category_option_id: productCategory,
      sample_kind_option_id: text(draft, "sample_kind_option_id"),
      formulation_type_option_id: text(draft, "formulation_type_option_id"),
      registration_category_option_id: text(
        draft,
        "registration_category_option_id",
      ),
      pic_crm_id: pic,
      sample_qty: qty,
      brand_name: brand,
      bpom_product_name: bpom,
      claims,
      packaging,
      reference_notes: reference,
      client_budget_idr: budget,
      special_requests_json: JSON.stringify(special),
      deadline_at: deadline,
      ship_to_address: address,
      is_dummy_required: draft.is_dummy_required,
      is_paid_sample: paid,
      is_test_requested: testing,
    },
  };
}

/**
 * WAJIB identik dengan `samples::CLIENT_LIFECYCLE_FROM_SAMPLES_SQL`. Klien
 * `LEAD` menjadi `FIRST_ORDER_ACTIVE` saat punya tiket yang belum ditutup
 * tanpa order (D-09), dan kembali `LEAD` bila semua tiketnya berakhir ditolak
 * atau dibatalkan (keputusan H). Aman diulang dan tidak menyentuh
 * `EXISTING_CLIENT`. Parameter: ?1 id klien, ?2 waktu perubahan.
 */
export const CLIENT_LIFECYCLE_FROM_SAMPLES_SQL =
  "UPDATE clients SET lifecycle_status = CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END, updated_at = ?2 WHERE id = ?1 AND lifecycle_status IN ('LEAD', 'FIRST_ORDER_ACTIVE') AND lifecycle_status <> CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END;";

// ---------------------------------------------------------------------------
// SQL tiket bersama. WAJIB identik dengan konstanta bernama sama di
// `samples.rs` (dites per karakter). Urutan parameter tercantum di sana.
// ---------------------------------------------------------------------------

export const SAMPLE_INSERT_SQL =
  "INSERT INTO sample_requests (id, client_id, lead_id, sample_kind_option_id, formulation_type_option_id, registration_category_option_id, rnd_product_class, product_category_option_id, pic_crm_id, sample_qty, brand_name, bpom_product_name, claims, packaging, reference_notes, client_budget_idr, special_requests_json, deadline_at, ship_to_address, is_dummy_required, is_paid_sample, revision_index, is_billable, status, rnd_lead_time_days, sent_at, status_changed_at, created_by, created_at, updated_at, is_test_requested) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 0, 0, 'DRAFT', NULL, '', ?21, ?22, ?21, ?21, ?23) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_UPDATE_SQL =
  "UPDATE sample_requests SET sample_kind_option_id = CASE WHEN status = 'DRAFT' THEN ?2 ELSE sample_kind_option_id END, formulation_type_option_id = CASE WHEN status = 'DRAFT' THEN ?3 ELSE formulation_type_option_id END, registration_category_option_id = CASE WHEN status = 'DRAFT' THEN ?4 ELSE registration_category_option_id END, product_category_option_id = CASE WHEN status = 'DRAFT' THEN ?5 ELSE product_category_option_id END, sample_qty = CASE WHEN status = 'DRAFT' THEN ?6 ELSE sample_qty END, brand_name = CASE WHEN status = 'DRAFT' THEN ?7 ELSE brand_name END, bpom_product_name = CASE WHEN status = 'DRAFT' THEN ?8 ELSE bpom_product_name END, claims = CASE WHEN status = 'DRAFT' THEN ?9 ELSE claims END, packaging = CASE WHEN status = 'DRAFT' THEN ?10 ELSE packaging END, reference_notes = CASE WHEN status = 'DRAFT' THEN ?11 ELSE reference_notes END, special_requests_json = CASE WHEN status = 'DRAFT' THEN ?12 ELSE special_requests_json END, is_dummy_required = CASE WHEN status = 'DRAFT' THEN ?13 ELSE is_dummy_required END, is_paid_sample = CASE WHEN status = 'DRAFT' THEN ?14 ELSE is_paid_sample END, is_test_requested = CASE WHEN status = 'DRAFT' THEN ?20 ELSE is_test_requested END, pic_crm_id = ?15, client_budget_idr = ?16, deadline_at = ?17, ship_to_address = ?18, updated_at = ?19 WHERE id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_ACC', 'CLIENT_REJECT', 'CANCELLED');";

export const SAMPLE_TRANSITION_SQL =
  "UPDATE sample_requests SET status = ?2, revision_index = ?3, is_billable = COALESCE(?4, is_billable), rnd_lead_time_days = COALESCE(?5, rnd_lead_time_days), rnd_product_class = COALESCE(?9, rnd_product_class), rnd_reject_reason_option_id = COALESCE(?10, rnd_reject_reason_option_id), revision_fee_idr = COALESCE(?11, revision_fee_idr), sent_at = CASE WHEN ?2 = 'SAMPLE_SENT' THEN ?6 ELSE sent_at END, status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND revision_index = ?8;";

export const SAMPLE_STATUS_LOG_INSERT_SQL =
  "INSERT INTO sample_status_log (id, sample_request_id, from_status, to_status, action, notes, on_behalf_of_division, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_FEEDBACK_INSERT_SQL =
  "INSERT INTO sample_feedbacks (id, sample_request_id, iteration_number, client_decision, client_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/**
 * Daftar/detail tiket. `unit_price_idr` = harga Finance terbaru untuk iterasi
 * yang sedang berjalan (NULL = belum diberi harga, gerbang D-27); `fee_paid`
 * dan `test_paid` = tagihan yang ditunggu sudah lunas atau sisanya sudah
 * dijadwal ulang menjadi cicilan (`RESCHEDULED`, v2.3b keputusan G). Harga yang
 * disimpan dalam detik yang sama dipisahkan `rowid` (urutan simpan).
 * ponytail: `rowid` hanya urutan simpan di database itu; dua harga satu iterasi
 * di detik yang sama dari DUA perangkat bisa terbaca berbeda setelah pull.
 * Tambah kolom urutan bila itu pernah terjadi. Dipakai Web
 * dan perangkat; WAJIB identik dengan `SAMPLE_LIST_SQL` di Rust.
 */
export const SAMPLE_LIST_SQL =
  "SELECT s.*, c.client_code, c.name AS client_name, c.free_revision_limit, o.nama_operator AS pic_crm_name, (SELECT p.final_unit_price_idr FROM pricing_formulas p WHERE p.sample_request_id = s.id AND p.iteration_number = s.revision_index + 1 ORDER BY p.recorded_at DESC, p.rowid DESC LIMIT 1) AS unit_price_idr, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND ((s.status = 'WAITING_SAMPLE_PAYMENT' AND i.ref_type = 'SAMPLE_FEE') OR (s.status = 'WAITING_REVISION_PAYMENT' AND i.ref_type = 'REVISION_FEE' AND i.revision_index = s.revision_index)) AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS fee_paid, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'TEST_FEE' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS test_paid, (SELECT d.status FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS design_status, (SELECT d.dummy_rejection_count FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS dummy_round, ((s.is_dummy_required = 0 AND NOT EXISTS (SELECT 1 FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED')) OR EXISTS (SELECT 1 FROM media_asset m WHERE m.owner_type = 'sample' AND m.owner_id = s.id AND m.purpose = 'MOCKUP')) AS mockup_ready, (SELECT m.status FROM production_mou m WHERE m.sample_request_id = s.id AND m.status NOT IN ('CANCELLED', 'REJECTED') ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS mou_status, (SELECT m.dp_amount_required_idr FROM production_mou m WHERE m.sample_request_id = s.id AND m.status = 'ACCEPTED' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS mou_dp_idr, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS dp_paid, (SELECT CASE m.regulatory_path WHEN 'WITH_BPOM' THEN 4 ELSE 1 END - (SELECT COUNT(DISTINCT l.kind) FROM legal_documents l WHERE l.mou_id = m.id AND l.status IN ('ISSUED', 'NOT_REQUIRED') AND (m.regulatory_path = 'WITH_BPOM' OR l.kind = 'HALAL')) FROM production_mou m WHERE m.sample_request_id = s.id AND m.status = 'ACCEPTED' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS legal_open, (SELECT CASE WHEN d.dummy_rejection_count = 0 THEN EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = 0 AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) ELSE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = d.dummy_rejection_count AND i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) END FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS dummy_paid, (SELECT m.status FROM production_mou m WHERE m.sample_request_id = s.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) IN ('REJECTED', 'CANCELLED') AS mou_closed, (SELECT b.material_status FROM production_batches b WHERE b.sample_request_id = s.id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS batch_material, (SELECT b.sched_packing_on FROM production_batches b WHERE b.sample_request_id = s.id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS batch_packing_on FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN master_operator o ON o.id = s.pic_crm_id";

/** Satu harga per simpan (v2.2), hanya-tambah; terbaru per iterasi berlaku. */
export const PRICE_INSERT_SQL =
  "INSERT INTO pricing_formulas (id, sample_request_id, iteration_number, raw_material_cost_idr, packaging_cost_idr, operational_cost_idr, regulatory_cost_idr, hpp_unit_idr, margin_bp, final_unit_price_idr, notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export const PRICES_SQL =
  "SELECT p.*, o.nama_operator AS recorded_by_name FROM pricing_formulas p LEFT JOIN master_operator o ON o.id = p.recorded_by WHERE p.sample_request_id = ?1 ORDER BY p.iteration_number, p.recorded_at, p.rowid;";

/** Kolom rincian HPP yang hanya untuk pemegang `pricing.view` (keputusan H). */
export const PRICE_COST_COLUMNS = [
  "raw_material_cost_idr",
  "packaging_cost_idr",
  "operational_cost_idr",
  "regulatory_cost_idr",
  "hpp_unit_idr",
  "margin_bp",
] as const;

/** Satu baris per sampel yang selesai dibuat RnD (v2.1), hanya-tambah. */
export const SAMPLE_FORMULA_INSERT_SQL =
  "INSERT INTO sample_formulas (id, sample_request_id, iteration_number, formula_code, product_knowledge, rnd_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_FORMULAS_SQL =
  "SELECT f.*, o.nama_operator AS recorded_by_name FROM sample_formulas f LEFT JOIN master_operator o ON o.id = f.recorded_by WHERE f.sample_request_id = ?1 ORDER BY f.iteration_number, f.recorded_at;";

/**
 * Tiket lain yang memakai formula code yang sama (keputusan E: kode tidak
 * unik, produk Existing memakai ulang formula). ?1 = sample id.
 */
export const SAMPLE_FORMULA_MATCHES_SQL =
  "SELECT DISTINCT f.formula_code, s.id AS sample_request_id, s.brand_name, s.status, c.client_code FROM sample_formulas f JOIN sample_requests s ON s.id = f.sample_request_id LEFT JOIN clients c ON c.id = s.client_id WHERE f.sample_request_id <> ?1 AND f.formula_code COLLATE NOCASE IN (SELECT formula_code FROM sample_formulas WHERE sample_request_id = ?1) ORDER BY f.formula_code, s.id LIMIT 20;";

export const SAMPLE_CHANGED_ELSEWHERE =
  "This sample request was changed on another device first. Sync, check its current status, then record the step again.";
