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
} as const;

export interface BusinessSettings {
  default_free_revision_limit: number;
  sample_fee_mode: SampleFeeMode;
  lead_hot_max_days: number;
  lead_warm_max_days: number;
}

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  default_free_revision_limit: 1,
  sample_fee_mode: "PER_REQUEST",
  lead_hot_max_days: 3,
  lead_warm_max_days: 7,
};

export const FREE_REVISION_LIMIT_MAX = 20;
export const LEAD_HOT_MAX_DAYS_LIMIT = 60;
export const LEAD_WARM_MAX_DAYS_LIMIT = 180;

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string" && /^\d{1,9}$/.test(value.trim())) {
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
  };
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
  return {
    settings: {
      default_free_revision_limit: limit,
      sample_fee_mode: mode as SampleFeeMode,
      lead_hot_max_days: hot,
      lead_warm_max_days: warm,
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
};

export const SAMPLE_NOTES_MAX = 1000;
export const RND_LEAD_TIME_MAX_DAYS = 365;

export interface SampleActionState {
  status: string;
  is_paid_sample: boolean;
  revision_index: number;
  free_revision_limit: number;
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

export function isSampleAction(value: unknown): value is SampleAction {
  return (
    typeof value === "string" &&
    (SAMPLE_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Satu langkah tiket. Seluruh diagram FR-06.4 ada di sini; langkah yang tidak
 * ada di diagram ditolak. `CLIENT_REVISE` langsung melewati gerbang kuota
 * (FR-06.5): revisi ke-n gratis selama n ≤ kuota klien.
 */
export function applySampleAction(
  state: SampleActionState,
  action: SampleAction,
  leadTimeDays: number | null,
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
    case "PAYMENT_RECEIVED":
      return step(
        ["WAITING_SAMPLE_PAYMENT", "WAITING_REVISION_PAYMENT"],
        "IN_RND",
      );
    case "SAMPLE_READY":
      return step(["IN_RND"], "SAMPLE_READY");
    case "SAMPLE_SENT":
      return step(["SAMPLE_READY"], "SAMPLE_SENT");
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
  "INSERT INTO sample_requests (id, client_id, lead_id, sample_kind_option_id, formulation_type_option_id, registration_category_option_id, rnd_product_class, product_category_option_id, pic_crm_id, sample_qty, brand_name, bpom_product_name, claims, packaging, reference_notes, client_budget_idr, special_requests_json, deadline_at, ship_to_address, is_dummy_required, is_paid_sample, revision_index, is_billable, status, rnd_lead_time_days, sent_at, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 0, 0, 'DRAFT', NULL, '', ?21, ?22, ?21, ?21) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_UPDATE_SQL =
  "UPDATE sample_requests SET sample_kind_option_id = CASE WHEN status = 'DRAFT' THEN ?2 ELSE sample_kind_option_id END, formulation_type_option_id = CASE WHEN status = 'DRAFT' THEN ?3 ELSE formulation_type_option_id END, registration_category_option_id = CASE WHEN status = 'DRAFT' THEN ?4 ELSE registration_category_option_id END, product_category_option_id = CASE WHEN status = 'DRAFT' THEN ?5 ELSE product_category_option_id END, sample_qty = CASE WHEN status = 'DRAFT' THEN ?6 ELSE sample_qty END, brand_name = CASE WHEN status = 'DRAFT' THEN ?7 ELSE brand_name END, bpom_product_name = CASE WHEN status = 'DRAFT' THEN ?8 ELSE bpom_product_name END, claims = CASE WHEN status = 'DRAFT' THEN ?9 ELSE claims END, packaging = CASE WHEN status = 'DRAFT' THEN ?10 ELSE packaging END, reference_notes = CASE WHEN status = 'DRAFT' THEN ?11 ELSE reference_notes END, special_requests_json = CASE WHEN status = 'DRAFT' THEN ?12 ELSE special_requests_json END, is_dummy_required = CASE WHEN status = 'DRAFT' THEN ?13 ELSE is_dummy_required END, is_paid_sample = CASE WHEN status = 'DRAFT' THEN ?14 ELSE is_paid_sample END, pic_crm_id = ?15, client_budget_idr = ?16, deadline_at = ?17, ship_to_address = ?18, updated_at = ?19 WHERE id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_ACC', 'CLIENT_REJECT', 'CANCELLED');";

export const SAMPLE_TRANSITION_SQL =
  "UPDATE sample_requests SET status = ?2, revision_index = ?3, is_billable = COALESCE(?4, is_billable), rnd_lead_time_days = COALESCE(?5, rnd_lead_time_days), sent_at = CASE WHEN ?2 = 'SAMPLE_SENT' THEN ?6 ELSE sent_at END, status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND revision_index = ?8;";

export const SAMPLE_STATUS_LOG_INSERT_SQL =
  "INSERT INTO sample_status_log (id, sample_request_id, from_status, to_status, action, notes, on_behalf_of_division, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_FEEDBACK_INSERT_SQL =
  "INSERT INTO sample_feedbacks (id, sample_request_id, iteration_number, client_decision, client_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

export const SAMPLE_CHANGED_ELSEWHERE =
  "This sample request was changed on another device first. Sync, check its current status, then record the step again.";
