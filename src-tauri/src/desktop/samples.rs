//! Aturan tiket sampel (PRD FR-06) dan setelan bisnis (FR-11).
//!
//! WAJIB identik dengan `src/lib/validations/sample.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `sample.test.ts`): tiket
//! yang sama harus berpindah ke status yang sama di Web dan di perangkat,
//! termasuk saat kuota revisi habis.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// Setelan bisnis (FR-11).
// ---------------------------------------------------------------------------

pub const SAMPLE_FEE_MODES: &[&str] = &["FREE", "PAID", "PER_REQUEST"];

pub const SETTING_DEFAULT_FREE_REVISION_LIMIT: &str = "default_free_revision_limit";
pub const SETTING_SAMPLE_FEE_MODE: &str = "sample_fee_mode";
pub const SETTING_LEAD_HOT_MAX_DAYS: &str = "lead_hot_max_days";
pub const SETTING_LEAD_WARM_MAX_DAYS: &str = "lead_warm_max_days";
pub const SETTING_MAX_PHOTOS_PER_SAMPLE: &str = "max_photos_per_sample";
pub const SETTING_TELEGRAM_CHAT_ID_CS: &str = "telegram_chat_id_cs";
pub const SETTING_TELEGRAM_CHAT_ID_RND: &str = "telegram_chat_id_rnd";
pub const SETTING_TELEGRAM_CHAT_ID_FINANCE: &str = "telegram_chat_id_finance";
pub const SETTING_OFFLINE_LOGIN_MAX_DAYS: &str = "offline_login_max_days";
pub const SETTING_DEFAULT_SAMPLE_FEE_IDR: &str = "default_sample_fee_idr";
pub const SETTING_DEFAULT_TEST_FEE_IDR: &str = "default_test_fee_idr";
pub const SETTING_INVOICE_DUE_DAYS: &str = "invoice_due_days";
pub const SETTING_INVOICE_PAYMENT_INSTRUCTIONS: &str = "invoice_payment_instructions";
pub const SETTING_TELEGRAM_CHAT_ID_DESIGN: &str = "telegram_chat_id_design";
pub const SETTING_TELEGRAM_CHAT_ID_PRODUCTION: &str = "telegram_chat_id_production";
pub const SETTING_DEFAULT_DUMMY_FEE_IDR: &str = "default_dummy_fee_idr";
pub const SETTING_MAX_DUMMY_REJECTIONS: &str = "max_dummy_rejections";
pub const SETTING_STORAGE_GRACE_DAYS: &str = "storage_grace_days";
pub const SETTING_STORAGE_FEE_IDR: &str = "storage_fee_idr";
pub const SETTING_STORAGE_SOP_TEXT: &str = "storage_sop_text";
pub const SETTING_DP_PERCENTAGE_BP: &str = "dp_percentage_bp";
pub const SETTING_APPROVAL_WEB_URL: &str = "approval_web_url";
pub const SETTING_APPROVAL_TOKEN_TTL_DAYS: &str = "approval_token_ttl_days";
pub const BUSINESS_SETTING_KEYS: &[&str] = &[
    SETTING_DEFAULT_FREE_REVISION_LIMIT,
    SETTING_SAMPLE_FEE_MODE,
    SETTING_LEAD_HOT_MAX_DAYS,
    SETTING_LEAD_WARM_MAX_DAYS,
    SETTING_MAX_PHOTOS_PER_SAMPLE,
    SETTING_TELEGRAM_CHAT_ID_CS,
    SETTING_TELEGRAM_CHAT_ID_RND,
    SETTING_TELEGRAM_CHAT_ID_FINANCE,
    SETTING_OFFLINE_LOGIN_MAX_DAYS,
    SETTING_DEFAULT_SAMPLE_FEE_IDR,
    SETTING_DEFAULT_TEST_FEE_IDR,
    SETTING_INVOICE_DUE_DAYS,
    SETTING_INVOICE_PAYMENT_INSTRUCTIONS,
    SETTING_TELEGRAM_CHAT_ID_DESIGN,
    SETTING_TELEGRAM_CHAT_ID_PRODUCTION,
    SETTING_DEFAULT_DUMMY_FEE_IDR,
    SETTING_MAX_DUMMY_REJECTIONS,
    SETTING_STORAGE_GRACE_DAYS,
    SETTING_STORAGE_FEE_IDR,
    SETTING_STORAGE_SOP_TEXT,
    SETTING_DP_PERCENTAGE_BP,
    SETTING_APPROVAL_WEB_URL,
    SETTING_APPROVAL_TOKEN_TTL_DAYS,
];

pub const FREE_REVISION_LIMIT_MAX: i64 = 20;
pub const LEAD_HOT_MAX_DAYS_LIMIT: i64 = 60;
pub const LEAD_WARM_MAX_DAYS_LIMIT: i64 = 180;
pub const MAX_PHOTOS_PER_SAMPLE_LIMIT: i64 = 50;
pub const OFFLINE_LOGIN_MAX_DAYS_LIMIT: i64 = 7;
pub const DEFAULT_FEE_MAX: i64 = 100_000_000_000;
pub const INVOICE_DUE_DAYS_LIMIT: i64 = 90;
pub const PAYMENT_INSTRUCTIONS_MAX: usize = 1000;
pub const STORAGE_SOP_MAX: usize = 2000;
pub const MAX_DUMMY_REJECTIONS_LIMIT: i64 = 20;
pub const STORAGE_GRACE_DAYS_LIMIT: i64 = 90;
pub const DP_PERCENTAGE_INVALID: &str = "The down payment must be from 0.01% to 100%.";
pub const APPROVAL_TTL_DAYS_LIMIT: i64 = 30;
pub const APPROVAL_WEB_URL_MAX: usize = 200;
pub const APPROVAL_WEB_URL_INVALID: &str = "Enter the approval web address as https://..., or leave it empty.";
pub const APPROVAL_TTL_INVALID: &str = "Approval links must last a whole number of days from 1 to 30.";

/// Padanan `normalizeApprovalWebUrl`: kosong, atau `https://host[:port][/path]`
/// tanpa garis miring penutup. `None` = tidak sah.
pub fn normalize_approval_web_url(value: &str) -> Option<String> {
    let text = value.trim().trim_end_matches('/');
    if text.is_empty() {
        return Some(String::new());
    }
    if text.len() > APPROVAL_WEB_URL_MAX {
        return None;
    }
    let rest = text.strip_prefix("https://")?;
    let (host_port, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let mut parts = host_port.split(':');
    let host = parts.next().unwrap_or_default();
    let port = parts.next();
    let extra = parts.next();
    let host_ok = !host.is_empty() && host.chars().all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '-'));
    let port_ok = port.is_none_or(|port| (1..=5).contains(&port.len()) && port.chars().all(|char| char.is_ascii_digit()));
    let path_ok = path.chars().all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '~' | '/' | '-'));
    (host_ok && port_ok && extra.is_none() && path_ok).then(|| text.to_owned())
}
pub const PAYMENT_INSTRUCTIONS_INVALID: &str = "Payment instructions are up to 1000 characters.";
pub const STORAGE_SOP_INVALID: &str = "The storage SOP is up to 2000 characters.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BusinessSettings {
    pub default_free_revision_limit: i64,
    pub sample_fee_mode: &'static str,
    pub lead_hot_max_days: i64,
    pub lead_warm_max_days: i64,
    pub max_photos_per_sample: i64,
    /// Grup Telegram per divisi (PRD FR-08). Kosong = tidak dikirim ke Telegram.
    pub telegram_chat_id_cs: String,
    pub telegram_chat_id_rnd: String,
    pub telegram_chat_id_finance: String,
    /// Masa login offline dalam hari, 1 sampai batas build (7 hari).
    pub offline_login_max_days: i64,
    /// Isian awal nominal tagihan biaya sampel dan uji (v2.3a); 0 = kosong.
    pub default_sample_fee_idr: i64,
    pub default_test_fee_idr: i64,
    /// Jatuh tempo tagihan = tanggal terbit + hari ini.
    pub invoice_due_days: i64,
    /// Teks bebas di invoice PDF (v2.3c).
    pub invoice_payment_instructions: String,
    /// Grup Telegram divisi Desain (v2.4, PRD F-19).
    pub telegram_chat_id_design: String,
    /// Grup Telegram Production: PPIC, SPV, QC, Logistik (v3.1, D-43).
    pub telegram_chat_id_production: String,
    /// Isian awal nominal tagihan dummy (v2.4); 0 = kosong.
    pub default_dummy_fee_idr: i64,
    /// Batas penolakan dummy (D-18, OQ-29); 0 = tanpa batas.
    pub max_dummy_rejections: i64,
    /// Masa bebas titip dan biaya titip per koli per hari (v3.3, D-19, OQ-30).
    pub storage_grace_days: i64,
    pub storage_fee_idr: i64,
    /// Teks SOP Penyimpanan untuk PDF pengiriman (v3.4); kosong = tanpa PDF.
    pub storage_sop_text: String,
    /// Persen DP bawaan MoU dalam basis poin (v2.5a, F-20).
    pub dp_percentage_bp: i64,
    /// Alamat Web tautan persetujuan (v2.5b); kosong = hanya jalur manual.
    pub approval_web_url: String,
    /// Masa berlaku tautan persetujuan dalam hari.
    pub approval_token_ttl_days: i64,
}

impl Default for BusinessSettings {
    fn default() -> Self {
        Self {
            default_free_revision_limit: 1,
            sample_fee_mode: "PER_REQUEST",
            lead_hot_max_days: 3,
            lead_warm_max_days: 7,
            max_photos_per_sample: 10,
            telegram_chat_id_cs: String::new(),
            telegram_chat_id_rnd: String::new(),
            telegram_chat_id_finance: String::new(),
            offline_login_max_days: 7,
            default_sample_fee_idr: 0,
            default_test_fee_idr: 0,
            invoice_due_days: 7,
            invoice_payment_instructions: String::new(),
            telegram_chat_id_design: String::new(),
            telegram_chat_id_production: String::new(),
            default_dummy_fee_idr: 0,
            max_dummy_rejections: 0,
            storage_grace_days: 14,
            storage_fee_idr: 0,
            storage_sop_text: String::new(),
            dp_percentage_bp: 5000,
            approval_web_url: String::new(),
            approval_token_ttl_days: 3,
        }
    }
}

impl BusinessSettings {
    pub fn to_json(&self) -> Value {
        json!({
            "default_free_revision_limit": self.default_free_revision_limit,
            "sample_fee_mode": self.sample_fee_mode,
            "lead_hot_max_days": self.lead_hot_max_days,
            "lead_warm_max_days": self.lead_warm_max_days,
            "max_photos_per_sample": self.max_photos_per_sample,
            "telegram_chat_id_cs": self.telegram_chat_id_cs,
            "telegram_chat_id_rnd": self.telegram_chat_id_rnd,
            "telegram_chat_id_finance": self.telegram_chat_id_finance,
            "offline_login_max_days": self.offline_login_max_days,
            "default_sample_fee_idr": self.default_sample_fee_idr,
            "default_test_fee_idr": self.default_test_fee_idr,
            "invoice_due_days": self.invoice_due_days,
            "invoice_payment_instructions": self.invoice_payment_instructions,
            "telegram_chat_id_design": self.telegram_chat_id_design,
            "telegram_chat_id_production": self.telegram_chat_id_production,
            "default_dummy_fee_idr": self.default_dummy_fee_idr,
            "max_dummy_rejections": self.max_dummy_rejections,
            "storage_grace_days": self.storage_grace_days,
            "storage_fee_idr": self.storage_fee_idr,
            "storage_sop_text": self.storage_sop_text,
            "dp_percentage_bp": self.dp_percentage_bp,
            "approval_web_url": self.approval_web_url,
            "approval_token_ttl_days": self.approval_token_ttl_days,
        })
    }

    /// Pasangan kunci → teks untuk `setting_gex_system`.
    pub fn to_rows(&self) -> Vec<(&'static str, String)> {
        vec![
            (SETTING_DEFAULT_FREE_REVISION_LIMIT, self.default_free_revision_limit.to_string()),
            (SETTING_SAMPLE_FEE_MODE, self.sample_fee_mode.to_owned()),
            (SETTING_LEAD_HOT_MAX_DAYS, self.lead_hot_max_days.to_string()),
            (SETTING_LEAD_WARM_MAX_DAYS, self.lead_warm_max_days.to_string()),
            (SETTING_MAX_PHOTOS_PER_SAMPLE, self.max_photos_per_sample.to_string()),
            (SETTING_TELEGRAM_CHAT_ID_CS, self.telegram_chat_id_cs.clone()),
            (SETTING_TELEGRAM_CHAT_ID_RND, self.telegram_chat_id_rnd.clone()),
            (SETTING_TELEGRAM_CHAT_ID_FINANCE, self.telegram_chat_id_finance.clone()),
            (SETTING_OFFLINE_LOGIN_MAX_DAYS, self.offline_login_max_days.to_string()),
            (SETTING_DEFAULT_SAMPLE_FEE_IDR, self.default_sample_fee_idr.to_string()),
            (SETTING_DEFAULT_TEST_FEE_IDR, self.default_test_fee_idr.to_string()),
            (SETTING_INVOICE_DUE_DAYS, self.invoice_due_days.to_string()),
            (SETTING_INVOICE_PAYMENT_INSTRUCTIONS, self.invoice_payment_instructions.clone()),
            (SETTING_TELEGRAM_CHAT_ID_DESIGN, self.telegram_chat_id_design.clone()),
            (SETTING_TELEGRAM_CHAT_ID_PRODUCTION, self.telegram_chat_id_production.clone()),
            (SETTING_DEFAULT_DUMMY_FEE_IDR, self.default_dummy_fee_idr.to_string()),
            (SETTING_MAX_DUMMY_REJECTIONS, self.max_dummy_rejections.to_string()),
            (SETTING_STORAGE_GRACE_DAYS, self.storage_grace_days.to_string()),
            (SETTING_STORAGE_FEE_IDR, self.storage_fee_idr.to_string()),
            (SETTING_STORAGE_SOP_TEXT, self.storage_sop_text.clone()),
            (SETTING_DP_PERCENTAGE_BP, self.dp_percentage_bp.to_string()),
            (SETTING_APPROVAL_WEB_URL, self.approval_web_url.clone()),
            (SETTING_APPROVAL_TOKEN_TTL_DAYS, self.approval_token_ttl_days.to_string()),
        ]
    }
}

fn stored_int(value: Option<&String>) -> Option<i64> {
    let text = value?.trim();
    if text.is_empty() || text.len() > 12 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn in_range(value: Option<i64>, min: i64, max: i64) -> Option<i64> {
    value.filter(|value| (min..=max).contains(value))
}

pub const TELEGRAM_CHAT_ID_INVALID: &str =
    "Enter a Telegram chat ID such as -1001234567890 or @channel_name, or leave it empty.";

/// Padanan `normalizeTelegramChatId`: kosong, angka (boleh negatif), atau
/// `@nama_channel`. `None` = tidak sah.
pub fn normalize_telegram_chat_id(value: &str) -> Option<String> {
    let text = value.trim();
    let digits = text.strip_prefix('-').unwrap_or(text);
    let numeric = (1..=20).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit());
    let channel = text.strip_prefix('@').is_some_and(|name| {
        (5..=32).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    });
    (text.is_empty() || numeric || channel).then(|| text.to_owned())
}

fn stored_chat_id(values: &HashMap<String, String>, key: &str) -> String {
    values
        .get(key)
        .and_then(|value| normalize_telegram_chat_id(value))
        .unwrap_or_default()
}

fn fee_mode(value: &str) -> Option<&'static str> {
    SAMPLE_FEE_MODES.iter().copied().find(|mode| *mode == value)
}

/// Padanan `readBusinessSettings`: nilai hilang atau rusak jatuh ke bawaan.
pub fn read_business_settings(values: &HashMap<String, String>) -> BusinessSettings {
    let defaults = BusinessSettings::default();
    let limit = in_range(
        stored_int(values.get(SETTING_DEFAULT_FREE_REVISION_LIMIT)),
        0,
        FREE_REVISION_LIMIT_MAX,
    );
    let mode = values
        .get(SETTING_SAMPLE_FEE_MODE)
        .and_then(|value| fee_mode(value.trim()));
    let hot = in_range(stored_int(values.get(SETTING_LEAD_HOT_MAX_DAYS)), 0, LEAD_HOT_MAX_DAYS_LIMIT);
    let warm = in_range(stored_int(values.get(SETTING_LEAD_WARM_MAX_DAYS)), 1, LEAD_WARM_MAX_DAYS_LIMIT);
    let (hot, warm) = match (hot, warm) {
        (Some(hot), Some(warm)) if warm > hot => (hot, warm),
        _ => (defaults.lead_hot_max_days, defaults.lead_warm_max_days),
    };
    BusinessSettings {
        default_free_revision_limit: limit.unwrap_or(defaults.default_free_revision_limit),
        sample_fee_mode: mode.unwrap_or(defaults.sample_fee_mode),
        lead_hot_max_days: hot,
        lead_warm_max_days: warm,
        max_photos_per_sample: in_range(
            stored_int(values.get(SETTING_MAX_PHOTOS_PER_SAMPLE)),
            1,
            MAX_PHOTOS_PER_SAMPLE_LIMIT,
        )
        .unwrap_or(defaults.max_photos_per_sample),
        telegram_chat_id_cs: stored_chat_id(values, SETTING_TELEGRAM_CHAT_ID_CS),
        telegram_chat_id_rnd: stored_chat_id(values, SETTING_TELEGRAM_CHAT_ID_RND),
        telegram_chat_id_finance: stored_chat_id(values, SETTING_TELEGRAM_CHAT_ID_FINANCE),
        offline_login_max_days: in_range(
            stored_int(values.get(SETTING_OFFLINE_LOGIN_MAX_DAYS)),
            1,
            OFFLINE_LOGIN_MAX_DAYS_LIMIT,
        )
        .unwrap_or(defaults.offline_login_max_days),
        default_sample_fee_idr: in_range(stored_int(values.get(SETTING_DEFAULT_SAMPLE_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .unwrap_or(defaults.default_sample_fee_idr),
        default_test_fee_idr: in_range(stored_int(values.get(SETTING_DEFAULT_TEST_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .unwrap_or(defaults.default_test_fee_idr),
        invoice_due_days: in_range(stored_int(values.get(SETTING_INVOICE_DUE_DAYS)), 0, INVOICE_DUE_DAYS_LIMIT)
            .unwrap_or(defaults.invoice_due_days),
        // Teks tersimpan yang terlalu panjang dianggap rusak dan jatuh ke kosong.
        invoice_payment_instructions: values
            .get(SETTING_INVOICE_PAYMENT_INSTRUCTIONS)
            .map(|text| text.trim().to_owned())
            .filter(|text| text.chars().count() <= PAYMENT_INSTRUCTIONS_MAX)
            .unwrap_or_default(),
        telegram_chat_id_design: stored_chat_id(values, SETTING_TELEGRAM_CHAT_ID_DESIGN),
        telegram_chat_id_production: stored_chat_id(values, SETTING_TELEGRAM_CHAT_ID_PRODUCTION),
        default_dummy_fee_idr: in_range(stored_int(values.get(SETTING_DEFAULT_DUMMY_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .unwrap_or(defaults.default_dummy_fee_idr),
        max_dummy_rejections: in_range(
            stored_int(values.get(SETTING_MAX_DUMMY_REJECTIONS)),
            0,
            MAX_DUMMY_REJECTIONS_LIMIT,
        )
        .unwrap_or(defaults.max_dummy_rejections),
        storage_grace_days: in_range(
            stored_int(values.get(SETTING_STORAGE_GRACE_DAYS)),
            0,
            STORAGE_GRACE_DAYS_LIMIT,
        )
        .unwrap_or(defaults.storage_grace_days),
        storage_fee_idr: in_range(stored_int(values.get(SETTING_STORAGE_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .unwrap_or(defaults.storage_fee_idr),
        storage_sop_text: values
            .get(SETTING_STORAGE_SOP_TEXT)
            .map(|text| text.trim().to_owned())
            .filter(|text| text.chars().count() <= STORAGE_SOP_MAX)
            .unwrap_or_default(),
        dp_percentage_bp: in_range(stored_int(values.get(SETTING_DP_PERCENTAGE_BP)), 1, 10_000)
            .unwrap_or(defaults.dp_percentage_bp),
        approval_web_url: values
            .get(SETTING_APPROVAL_WEB_URL)
            .and_then(|value| normalize_approval_web_url(value))
            .unwrap_or_default(),
        approval_token_ttl_days: in_range(
            stored_int(values.get(SETTING_APPROVAL_TOKEN_TTL_DAYS)),
            1,
            APPROVAL_TTL_DAYS_LIMIT,
        )
        .unwrap_or(defaults.approval_token_ttl_days),
    }
}

/// Tenggat login offline: yang paling awal antara batas yang dicatat saat
/// login online (`offline_valid_until`, dari batas build) dan masa offline
/// menurut setelan perusahaan sejak login online itu. Memperpendek setelan
/// berlaku segera setelah tersinkron, termasuk untuk snapshot yang sudah ada;
/// memperpanjangnya tidak pernah melewati batas build.
pub fn offline_login_deadline(provisioned_at: i64, offline_valid_until: i64, max_days: i64) -> i64 {
    offline_valid_until.min(provisioned_at.saturating_add(max_days.saturating_mul(86_400)))
}

/// Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak.
fn strict_int(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

/// Padanan `validateBusinessSettings`; pesan identik.
pub fn validate_business_settings(draft: &Value) -> Result<BusinessSettings, &'static str> {
    let limit = in_range(strict_int(draft.get("default_free_revision_limit")), 0, FREE_REVISION_LIMIT_MAX)
        .ok_or("Free revisions must be a whole number from 0 to 20.")?;
    let mode = draft
        .get("sample_fee_mode")
        .and_then(Value::as_str)
        .and_then(fee_mode)
        .ok_or("Choose how sample fees are charged.")?;
    let hot = in_range(strict_int(draft.get("lead_hot_max_days")), 0, LEAD_HOT_MAX_DAYS_LIMIT)
        .ok_or("The Hot limit must be a whole number of days from 0 to 60.")?;
    let warm = in_range(strict_int(draft.get("lead_warm_max_days")), 1, LEAD_WARM_MAX_DAYS_LIMIT)
        .filter(|warm| *warm > hot)
        .ok_or("The Warm limit must be more days than the Hot limit, up to 180.")?;
    let photos = in_range(strict_int(draft.get("max_photos_per_sample")), 1, MAX_PHOTOS_PER_SAMPLE_LIMIT)
        .ok_or("Photos per sample request must be a whole number from 1 to 50.")?;
    // Wajib dikirim, walau kosong: field yang hilang akan menimpa chat ID
    // tersimpan dengan kosong.
    let chat = |key: &str| {
        draft
            .get(key)
            .and_then(Value::as_str)
            .and_then(normalize_telegram_chat_id)
            .ok_or(TELEGRAM_CHAT_ID_INVALID)
    };
    let chat_cs = chat(SETTING_TELEGRAM_CHAT_ID_CS)?;
    let chat_rnd = chat(SETTING_TELEGRAM_CHAT_ID_RND)?;
    let chat_finance = chat(SETTING_TELEGRAM_CHAT_ID_FINANCE)?;
    let chat_design = chat(SETTING_TELEGRAM_CHAT_ID_DESIGN)?;
    let chat_production = chat(SETTING_TELEGRAM_CHAT_ID_PRODUCTION)?;
    Ok(BusinessSettings {
        default_free_revision_limit: limit,
        sample_fee_mode: mode,
        lead_hot_max_days: hot,
        lead_warm_max_days: warm,
        max_photos_per_sample: photos,
        telegram_chat_id_cs: chat_cs,
        telegram_chat_id_rnd: chat_rnd,
        telegram_chat_id_finance: chat_finance,
        offline_login_max_days: in_range(
            strict_int(draft.get(SETTING_OFFLINE_LOGIN_MAX_DAYS)),
            1,
            OFFLINE_LOGIN_MAX_DAYS_LIMIT,
        )
        .ok_or("The offline sign-in period must be a whole number of days from 1 to 7.")?,
        default_sample_fee_idr: in_range(strict_int(draft.get(SETTING_DEFAULT_SAMPLE_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .ok_or("Default fees must be whole rupiah amounts.")?,
        default_test_fee_idr: in_range(strict_int(draft.get(SETTING_DEFAULT_TEST_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .ok_or("Default fees must be whole rupiah amounts.")?,
        invoice_due_days: in_range(strict_int(draft.get(SETTING_INVOICE_DUE_DAYS)), 0, INVOICE_DUE_DAYS_LIMIT)
            .ok_or("The invoice due period must be a whole number of days from 0 to 90.")?,
        // Wajib dikirim, walau kosong: field yang hilang akan menimpa teks tersimpan.
        invoice_payment_instructions: draft
            .get(SETTING_INVOICE_PAYMENT_INSTRUCTIONS)
            .and_then(Value::as_str)
            .map(|text| text.trim().to_owned())
            .filter(|text| text.chars().count() <= PAYMENT_INSTRUCTIONS_MAX)
            .ok_or(PAYMENT_INSTRUCTIONS_INVALID)?,
        telegram_chat_id_design: chat_design,
        telegram_chat_id_production: chat_production,
        default_dummy_fee_idr: in_range(strict_int(draft.get(SETTING_DEFAULT_DUMMY_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .ok_or("Default fees must be whole rupiah amounts.")?,
        max_dummy_rejections: in_range(
            strict_int(draft.get(SETTING_MAX_DUMMY_REJECTIONS)),
            0,
            MAX_DUMMY_REJECTIONS_LIMIT,
        )
        .ok_or("The dummy rejection limit must be a whole number from 0 to 20.")?,
        storage_grace_days: in_range(
            strict_int(draft.get(SETTING_STORAGE_GRACE_DAYS)),
            0,
            STORAGE_GRACE_DAYS_LIMIT,
        )
        .ok_or("The free storage period must be a whole number of days from 0 to 90.")?,
        storage_fee_idr: in_range(strict_int(draft.get(SETTING_STORAGE_FEE_IDR)), 0, DEFAULT_FEE_MAX)
            .ok_or("The storage fee must be a whole rupiah amount.")?,
        // Wajib dikirim, walau kosong: field yang hilang akan menimpa teks tersimpan.
        storage_sop_text: draft
            .get(SETTING_STORAGE_SOP_TEXT)
            .and_then(Value::as_str)
            .map(|text| text.trim().to_owned())
            .filter(|text| text.chars().count() <= STORAGE_SOP_MAX)
            .ok_or(STORAGE_SOP_INVALID)?,
        dp_percentage_bp: in_range(strict_int(draft.get(SETTING_DP_PERCENTAGE_BP)), 1, 10_000)
            .ok_or(DP_PERCENTAGE_INVALID)?,
        // Wajib dikirim, walau kosong: field yang hilang akan menimpa alamat tersimpan.
        approval_web_url: draft
            .get(SETTING_APPROVAL_WEB_URL)
            .and_then(Value::as_str)
            .and_then(normalize_approval_web_url)
            .ok_or(APPROVAL_WEB_URL_INVALID)?,
        approval_token_ttl_days: in_range(
            strict_int(draft.get(SETTING_APPROVAL_TOKEN_TTL_DAYS)),
            1,
            APPROVAL_TTL_DAYS_LIMIT,
        )
        .ok_or(APPROVAL_TTL_INVALID)?,
    })
}

// ---------------------------------------------------------------------------
// Status dan aksi tiket (FR-06.4).
// ---------------------------------------------------------------------------

pub const SAMPLE_STATUSES: &[&str] = &[
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
];

pub const SAMPLE_TERMINAL_STATUSES: &[&str] = &["RND_REJECTED", "CLIENT_ACC", "CLIENT_REJECT", "CANCELLED"];

pub const SAMPLE_ACTIONS: &[&str] = &[
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
];

pub const SAMPLE_NOTES_MAX: usize = 1000;
pub const RND_LEAD_TIME_MAX_DAYS: i64 = 365;
pub const SAMPLE_STEP_NOT_ALLOWED: &str = "This step is not allowed from the current status.";
pub const SAMPLE_NOT_PRICED: &str = "Finance has not priced this sample yet.";
pub const SAMPLE_FEE_UNPAID: &str = "Record the payment on this sample's invoice first.";
pub const SAMPLE_TEST_UNPAID: &str = "The testing fee for this sample is not paid yet.";
pub const SAMPLE_MOCKUP_MISSING: &str = "Upload the mockup before sending the sample.";
pub const REVISION_FEE_INVALID: &str = "Enter the revision fee in whole rupiah (0 waives it).";

/// Padanan `SAMPLE_ACTION_DIVISION`: divisi yang sebenarnya memutuskan.
pub fn sample_action_division(action: &str) -> Option<&'static str> {
    match action {
        "RND_ACCEPT" | "RND_REJECT" | "SAMPLE_READY" => Some("RnD"),
        "PAYMENT_RECEIVED" | "SET_REVISION_FEE" => Some("Finance"),
        _ => None,
    }
}

/// Padanan `sampleActionPermission`: langkah RnD milik `rnd.manage` (v2.1),
/// langkah Finance milik `finance.manage` (v2.2), sisanya `samples.manage`.
pub fn sample_action_permission(action: &str) -> &'static str {
    match action {
        "RND_ACCEPT" | "RND_REJECT" | "SAMPLE_READY" => "rnd.manage",
        "PAYMENT_RECEIVED" | "SET_REVISION_FEE" => "finance.manage",
        _ => "samples.manage",
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampleActionState<'a> {
    pub status: &'a str,
    pub is_paid_sample: bool,
    pub revision_index: i64,
    pub free_revision_limit: i64,
    /// Iterasi yang sedang berjalan sudah diberi harga Finance (D-27).
    pub has_price: bool,
    /// Tagihan biaya sampel/revisi yang sedang ditunggu sudah lunas (v2.3a).
    pub fee_paid: bool,
    /// Tidak diminta uji, atau tagihan uji sudah lunas (D-30).
    pub test_ready: bool,
    /// Tiket tidak butuh mockup, atau mockup sudah diunggah (v2.4, D-36).
    pub mockup_ready: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampleActionResult {
    pub status: &'static str,
    pub revision_index: i64,
    pub is_billable: Option<bool>,
    pub client_decision: Option<&'static str>,
}

/// Padanan `applySampleAction`: seluruh diagram FR-06.4 ada di sini.
pub fn apply_sample_action(
    state: &SampleActionState<'_>,
    action: &str,
    lead_time_days: Option<i64>,
    revision_fee_idr: Option<i64>,
) -> Result<SampleActionResult, &'static str> {
    let step = |from: &[&str], status: &'static str| -> Result<SampleActionResult, &'static str> {
        if from.contains(&state.status) {
            Ok(SampleActionResult {
                status,
                revision_index: state.revision_index,
                is_billable: None,
                client_decision: None,
            })
        } else {
            Err(SAMPLE_STEP_NOT_ALLOWED)
        }
    };
    match action {
        "SUBMIT_TO_RND" => step(&["DRAFT"], "RND_REVIEW"),
        "RND_ACCEPT" => {
            if state.status != "RND_REVIEW" {
                return Err(SAMPLE_STEP_NOT_ALLOWED);
            }
            if !lead_time_days.is_some_and(|days| (1..=RND_LEAD_TIME_MAX_DAYS).contains(&days)) {
                return Err("Enter the RnD lead time in days (1-365).");
            }
            step(&["RND_REVIEW"], "RND_ACCEPTED")
        }
        "RND_REJECT" => step(&["RND_REVIEW"], "RND_REJECTED"),
        "PROCEED" => step(
            &["RND_ACCEPTED"],
            if state.is_paid_sample { "WAITING_SAMPLE_PAYMENT" } else { "IN_RND" },
        ),
        "PAYMENT_RECEIVED" => {
            let result = step(&["WAITING_SAMPLE_PAYMENT", "WAITING_REVISION_PAYMENT"], "IN_RND")?;
            if !state.fee_paid {
                return Err(SAMPLE_FEE_UNPAID);
            }
            Ok(result)
        }
        "SAMPLE_READY" => step(&["IN_RND"], "SAMPLE_READY"),
        "SAMPLE_SENT" => {
            if state.status == "SAMPLE_READY" && !state.has_price {
                return Err(SAMPLE_NOT_PRICED);
            }
            if state.status == "SAMPLE_READY" && !state.test_ready {
                return Err(SAMPLE_TEST_UNPAID);
            }
            if state.status == "SAMPLE_READY" && !state.mockup_ready {
                return Err(SAMPLE_MOCKUP_MISSING);
            }
            step(&["SAMPLE_READY"], "SAMPLE_SENT")
        }
        "SET_REVISION_FEE" => {
            if state.status != "PENDING_FEE_ASSESSMENT" {
                return Err(SAMPLE_STEP_NOT_ALLOWED);
            }
            let fee = revision_fee_idr
                .filter(|fee| (0..=SAMPLE_BUDGET_MAX).contains(fee))
                .ok_or(REVISION_FEE_INVALID)?;
            Ok(SampleActionResult {
                status: if fee == 0 { "IN_RND" } else { "WAITING_REVISION_PAYMENT" },
                revision_index: state.revision_index,
                is_billable: (fee == 0).then_some(false),
                client_decision: None,
            })
        }
        "CLIENT_ACC" => step(&["SAMPLE_SENT"], "CLIENT_ACC").map(|result| SampleActionResult {
            client_decision: Some("ACC"),
            ..result
        }),
        "CLIENT_REJECT" => step(&["SAMPLE_SENT"], "CLIENT_REJECT").map(|result| SampleActionResult {
            client_decision: Some("REJECT"),
            ..result
        }),
        "CLIENT_REVISE" => {
            if state.status != "SAMPLE_SENT" {
                return Err(SAMPLE_STEP_NOT_ALLOWED);
            }
            let index = state.revision_index + 1;
            let free = index <= state.free_revision_limit;
            Ok(SampleActionResult {
                status: if free { "IN_RND" } else { "PENDING_FEE_ASSESSMENT" },
                revision_index: index,
                is_billable: Some(!free),
                client_decision: Some("REVISE"),
            })
        }
        "CANCEL" => {
            if SAMPLE_TERMINAL_STATUSES.contains(&state.status) || !SAMPLE_STATUSES.contains(&state.status) {
                Err(SAMPLE_STEP_NOT_ALLOWED)
            } else {
                Ok(SampleActionResult {
                    status: "CANCELLED",
                    revision_index: state.revision_index,
                    is_billable: None,
                    client_decision: None,
                })
            }
        }
        _ => Err(SAMPLE_STEP_NOT_ALLOWED),
    }
}

/// Padanan `normalizeSampleNotes`: catatan wajib di setiap langkah (FR-06.6).
pub fn normalize_sample_notes(value: &str) -> Option<String> {
    let notes = value.trim();
    (!notes.is_empty() && notes.chars().count() <= SAMPLE_NOTES_MAX).then(|| notes.to_owned())
}

// ---------------------------------------------------------------------------
// Isian langkah RnD (v2.1, PRD F-14). Padanan `validateRndStep`.
// ---------------------------------------------------------------------------

pub const RND_PRODUCT_CLASSES: &[&str] = &["NEW", "EXISTING"];
pub const FORMULA_CODE_MAX: usize = 60;
pub const PRODUCT_KNOWLEDGE_MAX: usize = 2000;

/// `None` = langkah ini tidak mengubah kolom itu.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RndStep {
    pub product_class: Option<&'static str>,
    pub reject_reason_option_id: Option<String>,
    pub formula_code: Option<String>,
    pub product_knowledge: Option<String>,
}

/// Padanan `validateRndStep`; pesan identik. `input` = objek `rnd` dari
/// gateway (`None` atau bukan objek dibaca sebagai objek kosong).
pub fn validate_rnd_step(action: &str, input: Option<&Value>) -> Result<RndStep, &'static str> {
    let empty = Value::Object(Map::new());
    let raw = input.filter(|value| value.is_object()).unwrap_or(&empty);
    let class_text = draft_text(raw, "product_class");
    let product_class = RND_PRODUCT_CLASSES.iter().copied().find(|class| *class == class_text);
    match action {
        "RND_ACCEPT" => Ok(RndStep {
            product_class: Some(product_class.ok_or("Choose whether this is a new or an existing product.")?),
            ..RndStep::default()
        }),
        "RND_REJECT" => {
            if !class_text.is_empty() && product_class.is_none() {
                return Err("Choose whether this is a new or an existing product.");
            }
            let reason = draft_text(raw, "reject_reason_option_id");
            if reason.is_empty() {
                return Err("Choose the reason RnD rejected the request.");
            }
            Ok(RndStep {
                product_class,
                reject_reason_option_id: Some(reason),
                ..RndStep::default()
            })
        }
        "SAMPLE_READY" => {
            let code = draft_text(raw, "formula_code");
            if code.is_empty() || code.chars().count() > FORMULA_CODE_MAX {
                return Err("Enter the formula code, up to 60 characters.");
            }
            let knowledge = draft_text(raw, "product_knowledge");
            if knowledge.is_empty() || knowledge.chars().count() > PRODUCT_KNOWLEDGE_MAX {
                return Err("Enter the product knowledge, up to 2000 characters.");
            }
            Ok(RndStep {
                formula_code: Some(code),
                product_knowledge: Some(knowledge),
                ..RndStep::default()
            })
        }
        _ => Ok(RndStep::default()),
    }
}

// ---------------------------------------------------------------------------
// Harga satuan (v2.2, PRD F-16, D-16, D-27). Padanan `computeUnitPrice`.
// ---------------------------------------------------------------------------

pub const PRICE_COMPONENT_MAX: i64 = 1_000_000_000;
pub const MARGIN_BP_MAX: i64 = 9500;
const PRICE_COMPONENTS: [&str; 4] = [
    "raw_material_cost_idr",
    "packaging_cost_idr",
    "operational_cost_idr",
    "regulatory_cost_idr",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitPrice {
    pub raw_material_cost_idr: i64,
    pub packaging_cost_idr: i64,
    pub operational_cost_idr: i64,
    pub regulatory_cost_idr: i64,
    pub margin_bp: i64,
    pub hpp_unit_idr: i64,
    pub final_unit_price_idr: i64,
    pub notes: String,
}

/// Padanan `computeUnitPrice`: harga jual = HPP / (1 - margin), margin atas
/// harga jual, dibulatkan ke atas ke rupiah penuh (D-16). Pesan identik.
pub fn compute_unit_price(input: &Value) -> Result<UnitPrice, &'static str> {
    let mut costs = [0_i64; 4];
    for (slot, key) in costs.iter_mut().zip(PRICE_COMPONENTS) {
        *slot = strict_int(input.get(key))
            .filter(|value| (0..=PRICE_COMPONENT_MAX).contains(value))
            .ok_or("Each cost must be a whole rupiah amount per unit.")?;
    }
    let hpp: i64 = costs.iter().sum();
    if hpp < 1 {
        return Err("Enter at least one cost.");
    }
    let margin = strict_int(input.get("margin_bp"))
        .filter(|value| (0..=MARGIN_BP_MAX).contains(value))
        .ok_or("The margin must be from 0% to 95%.")?;
    let notes = draft_text(input, "notes");
    if notes.chars().count() > SAMPLE_NOTES_MAX {
        return Err("Notes are up to 1000 characters.");
    }
    let divisor = 10_000 - margin;
    let scaled = hpp * 10_000;
    Ok(UnitPrice {
        raw_material_cost_idr: costs[0],
        packaging_cost_idr: costs[1],
        operational_cost_idr: costs[2],
        regulatory_cost_idr: costs[3],
        margin_bp: margin,
        hpp_unit_idr: hpp,
        final_unit_price_idr: (scaled + divisor - 1) / divisor,
        notes,
    })
}

/// Padanan `formatRupiah`: `Rp 32.500`.
pub fn format_rupiah(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    format!("{}Rp {grouped}", if value < 0 { "-" } else { "" })
}

// ---------------------------------------------------------------------------
// Draft tiket (FR-06.1).
// ---------------------------------------------------------------------------

/// Padanan `SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT` (keputusan G).
pub const SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT: &[&str] =
    &["deadline_at", "ship_to_address", "pic_crm_id", "client_budget_idr"];

pub const SAMPLE_QTY_MAX: i64 = 10_000;
pub const SAMPLE_TEXT_MAX: usize = 300;
pub const SAMPLE_BRAND_MAX: usize = 120;
pub const SAMPLE_LONG_TEXT_MAX: usize = 2000;
pub const SAMPLE_BUDGET_MAX: i64 = 1_000_000_000_000;
pub const SPECIAL_REQUEST_KEYS: &[&str] = &["color", "texture", "size", "aroma"];

/// Padanan `isCalendarDate`: `YYYY-MM-DD` yang benar-benar ada.
pub fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        value[0..4].parse::<i64>(),
        value[5..7].parse::<i64>(),
        value[8..10].parse::<i64>(),
    ) else {
        return false;
    };
    if year < 2000 || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day <= days[(month - 1) as usize]
}

fn draft_text(draft: &Value, key: &str) -> String {
    draft
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        _ => false,
    }
}

/// Padanan `validateSampleDraft`. Mengembalikan objek JSON dengan kunci yang
/// sama persis dengan `SampleDraft` di TS.
pub fn validate_sample_draft(draft: &Value, fee_mode: &str) -> Result<Value, &'static str> {
    let product_category = draft_text(draft, "product_category_option_id");
    if product_category.is_empty() {
        return Err("Choose the product type.");
    }
    let qty = strict_int(draft.get("sample_qty"))
        .filter(|qty| (1..=SAMPLE_QTY_MAX).contains(qty))
        .ok_or("Enter the sample quantity (1-10000).")?;
    let brand = draft_text(draft, "brand_name");
    if brand.is_empty() || brand.chars().count() > SAMPLE_BRAND_MAX {
        return Err("The brand name is required, up to 120 characters.");
    }
    let packaging = draft_text(draft, "packaging");
    if packaging.is_empty() || packaging.chars().count() > SAMPLE_TEXT_MAX {
        return Err("The packaging is required, up to 300 characters.");
    }
    let deadline = draft_text(draft, "deadline_at");
    if !is_calendar_date(&deadline) {
        return Err("Enter the date the sample must reach the client.");
    }
    let address = draft_text(draft, "ship_to_address");
    if address.is_empty() || address.chars().count() > SAMPLE_TEXT_MAX {
        return Err("The shipping address is required, up to 300 characters.");
    }
    let Some(dummy) = draft.get("is_dummy_required").and_then(Value::as_bool) else {
        return Err("Choose whether a packaging dummy is needed.");
    };
    // Opsional: event lama yang belum membawa kunci ini berarti tanpa uji.
    let testing = match draft.get("is_test_requested") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(testing)) => *testing,
        Some(_) => return Err("Choose whether the sample is tested."),
    };

    let bpom = draft_text(draft, "bpom_product_name");
    let claims = draft_text(draft, "claims");
    let reference = draft_text(draft, "reference_notes");
    if bpom.chars().count() > SAMPLE_BRAND_MAX
        || claims.chars().count() > SAMPLE_LONG_TEXT_MAX
        || reference.chars().count() > SAMPLE_LONG_TEXT_MAX
    {
        return Err("One of the text fields is too long.");
    }

    // `serde_json` dengan `preserve_order` tidak dijamin aktif, jadi JSON-nya
    // dirakit tangan dengan urutan tetap, sama dengan `JSON.stringify` di TS.
    let empty = Value::Object(Map::new());
    let raw_special = draft.get("special_requests").filter(|value| value.is_object()).unwrap_or(&empty);
    let mut parts = Vec::with_capacity(SPECIAL_REQUEST_KEYS.len());
    for key in SPECIAL_REQUEST_KEYS {
        let value = draft_text(raw_special, key);
        if value.chars().count() > SAMPLE_TEXT_MAX {
            return Err("Each special request is up to 300 characters.");
        }
        parts.push(format!("{}:{}", json!(key), json!(value)));
    }
    let special_json = format!("{{{}}}", parts.join(","));

    let budget = if is_blank(draft.get("client_budget_idr")) {
        None
    } else {
        Some(
            strict_int(draft.get("client_budget_idr"))
                .filter(|budget| (0..=SAMPLE_BUDGET_MAX).contains(budget))
                .ok_or("The client budget must be a whole rupiah amount.")?,
        )
    };
    let pic = match draft.get("pic_crm_id") {
        None | Some(Value::Null) => None,
        Some(value) if value.as_i64() == Some(0) => None,
        Some(value) => Some(
            value
                .as_i64()
                .filter(|id| *id >= 1)
                .ok_or("Choose an active CRM operator.")?,
        ),
    };

    let requested = draft.get("is_paid_sample").and_then(Value::as_bool);
    let paid = if fee_mode == "PER_REQUEST" {
        requested.ok_or("Choose whether this sample is paid.")?
    } else {
        let paid = fee_mode == "PAID";
        if requested.is_some_and(|requested| requested != paid) {
            return Err(if paid {
                "Company settings make every sample paid."
            } else {
                "Company settings make every sample free."
            });
        }
        paid
    };

    Ok(json!({
        "product_category_option_id": product_category,
        "sample_kind_option_id": draft_text(draft, "sample_kind_option_id"),
        "formulation_type_option_id": draft_text(draft, "formulation_type_option_id"),
        "registration_category_option_id": draft_text(draft, "registration_category_option_id"),
        "pic_crm_id": pic,
        "sample_qty": qty,
        "brand_name": brand,
        "bpom_product_name": bpom,
        "claims": claims,
        "packaging": packaging,
        "reference_notes": reference,
        "client_budget_idr": budget,
        "special_requests_json": special_json,
        "deadline_at": deadline,
        "ship_to_address": address,
        "is_dummy_required": dummy,
        "is_paid_sample": paid,
        "is_test_requested": testing,
    }))
}

/// WAJIB identik dengan `CLIENT_LIFECYCLE_FROM_SAMPLES_SQL` di `sample.ts`.
/// Parameter: ?1 id klien, ?2 waktu perubahan.
pub const CLIENT_LIFECYCLE_FROM_SAMPLES_SQL: &str = "UPDATE clients SET lifecycle_status = CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END, updated_at = ?2 WHERE id = ?1 AND lifecycle_status IN ('LEAD', 'FIRST_ORDER_ACTIVE') AND lifecycle_status <> CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END;";

/// SQL tiket bersama untuk cloud, SQLite lokal, dan Web (`sample.ts`),
/// WAJIB identik. Parameter tercantum di komentar masing-masing.
///
/// ?1 id, ?2 client_id, ?3 lead_id, ?4 sample_kind, ?5 formulation_type,
/// ?6 registration_category, ?7 product_category, ?8 pic_crm_id, ?9 qty,
/// ?10 brand, ?11 bpom, ?12 claims, ?13 packaging, ?14 reference,
/// ?15 budget, ?16 special_requests_json, ?17 deadline, ?18 address,
/// ?19 dummy, ?20 paid, ?21 waktu, ?22 created_by, ?23 uji (D-30).
pub const SAMPLE_INSERT_SQL: &str = "INSERT INTO sample_requests (id, client_id, lead_id, sample_kind_option_id, formulation_type_option_id, registration_category_option_id, rnd_product_class, product_category_option_id, pic_crm_id, sample_qty, brand_name, bpom_product_name, claims, packaging, reference_notes, client_budget_idr, special_requests_json, deadline_at, ship_to_address, is_dummy_required, is_paid_sample, revision_index, is_billable, status, rnd_lead_time_days, sent_at, status_changed_at, created_by, created_at, updated_at, is_test_requested) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 0, 0, 'DRAFT', NULL, '', ?21, ?22, ?21, ?21, ?23) ON CONFLICT(id) DO NOTHING;";

/// Keputusan G ditegakkan di SQL: spesifikasi produk hanya berubah selama
/// `DRAFT`; deadline, alamat, PIC CRM, dan budget boleh berubah sampai tiket
/// ditutup. ?1 id, ?2-?14 spesifikasi (urutan sama dengan kolom di bawah),
/// ?15 pic_crm_id, ?16 budget, ?17 deadline, ?18 address, ?19 waktu,
/// ?20 uji (D-30, hanya selama `DRAFT`).
pub const SAMPLE_UPDATE_SQL: &str = "UPDATE sample_requests SET sample_kind_option_id = CASE WHEN status = 'DRAFT' THEN ?2 ELSE sample_kind_option_id END, formulation_type_option_id = CASE WHEN status = 'DRAFT' THEN ?3 ELSE formulation_type_option_id END, registration_category_option_id = CASE WHEN status = 'DRAFT' THEN ?4 ELSE registration_category_option_id END, product_category_option_id = CASE WHEN status = 'DRAFT' THEN ?5 ELSE product_category_option_id END, sample_qty = CASE WHEN status = 'DRAFT' THEN ?6 ELSE sample_qty END, brand_name = CASE WHEN status = 'DRAFT' THEN ?7 ELSE brand_name END, bpom_product_name = CASE WHEN status = 'DRAFT' THEN ?8 ELSE bpom_product_name END, claims = CASE WHEN status = 'DRAFT' THEN ?9 ELSE claims END, packaging = CASE WHEN status = 'DRAFT' THEN ?10 ELSE packaging END, reference_notes = CASE WHEN status = 'DRAFT' THEN ?11 ELSE reference_notes END, special_requests_json = CASE WHEN status = 'DRAFT' THEN ?12 ELSE special_requests_json END, is_dummy_required = CASE WHEN status = 'DRAFT' THEN ?13 ELSE is_dummy_required END, is_paid_sample = CASE WHEN status = 'DRAFT' THEN ?14 ELSE is_paid_sample END, is_test_requested = CASE WHEN status = 'DRAFT' THEN ?20 ELSE is_test_requested END, pic_crm_id = ?15, client_budget_idr = ?16, deadline_at = ?17, ship_to_address = ?18, updated_at = ?19 WHERE id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_ACC', 'CLIENT_REJECT', 'CANCELLED');";

/// Satu langkah tiket, hanya bila status dan revisinya masih seperti yang
/// dilihat pencatat. ?1 id, ?2 status baru, ?3 revisi baru, ?4 billable
/// (NULL = tetap), ?5 lead time RnD (NULL = tetap), ?6 waktu, ?7 status lama,
/// ?8 revisi lama, ?9 klasifikasi New/Existing dan ?10 alasan tolak RnD
/// (keduanya NULL = tetap), ?11 tarif revisi Finance (NULL = tetap).
pub const SAMPLE_TRANSITION_SQL: &str = "UPDATE sample_requests SET status = ?2, revision_index = ?3, is_billable = COALESCE(?4, is_billable), rnd_lead_time_days = COALESCE(?5, rnd_lead_time_days), rnd_product_class = COALESCE(?9, rnd_product_class), rnd_reject_reason_option_id = COALESCE(?10, rnd_reject_reason_option_id), revision_fee_idr = COALESCE(?11, revision_fee_idr), sent_at = CASE WHEN ?2 = 'SAMPLE_SENT' THEN ?6 ELSE sent_at END, status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND revision_index = ?8;";

pub const SAMPLE_STATUS_LOG_INSERT_SQL: &str = "INSERT INTO sample_status_log (id, sample_request_id, from_status, to_status, action, notes, on_behalf_of_division, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

pub const SAMPLE_FEEDBACK_INSERT_SQL: &str = "INSERT INTO sample_feedbacks (id, sample_request_id, iteration_number, client_decision, client_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/// Padanan `SAMPLE_LIST_SQL`: `unit_price_idr` = harga Finance terbaru untuk
/// iterasi yang sedang berjalan (NULL = belum diberi harga, gerbang D-27).
/// Seri di detik yang sama dipisahkan `rowid`; lihat catatan `ponytail` di TS.
pub const SAMPLE_LIST_SQL: &str = "SELECT s.*, c.client_code, c.name AS client_name, c.free_revision_limit, o.nama_operator AS pic_crm_name, (SELECT p.final_unit_price_idr FROM pricing_formulas p WHERE p.sample_request_id = s.id AND p.iteration_number = s.revision_index + 1 ORDER BY p.recorded_at DESC, p.rowid DESC LIMIT 1) AS unit_price_idr, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND ((s.status = 'WAITING_SAMPLE_PAYMENT' AND i.ref_type = 'SAMPLE_FEE') OR (s.status = 'WAITING_REVISION_PAYMENT' AND i.ref_type = 'REVISION_FEE' AND i.revision_index = s.revision_index)) AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS fee_paid, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'TEST_FEE' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS test_paid, (SELECT d.status FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS design_status, (SELECT d.dummy_rejection_count FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS dummy_round, ((s.is_dummy_required = 0 AND NOT EXISTS (SELECT 1 FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED')) OR EXISTS (SELECT 1 FROM media_asset m WHERE m.owner_type = 'sample' AND m.owner_id = s.id AND m.purpose = 'MOCKUP')) AS mockup_ready, (SELECT m.status FROM production_mou m WHERE m.sample_request_id = s.id AND m.status NOT IN ('CANCELLED', 'REJECTED') ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS mou_status, (SELECT m.dp_amount_required_idr FROM production_mou m WHERE m.sample_request_id = s.id AND m.status = 'ACCEPTED' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS mou_dp_idr, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS dp_paid, (SELECT CASE m.regulatory_path WHEN 'WITH_BPOM' THEN 4 ELSE 1 END - (SELECT COUNT(DISTINCT l.kind) FROM legal_documents l WHERE l.mou_id = m.id AND l.status IN ('ISSUED', 'NOT_REQUIRED') AND (m.regulatory_path = 'WITH_BPOM' OR l.kind = 'HALAL')) FROM production_mou m WHERE m.sample_request_id = s.id AND m.status = 'ACCEPTED' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS legal_open, (SELECT CASE WHEN d.dummy_rejection_count = 0 THEN EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = 0 AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) ELSE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = s.id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = d.dummy_rejection_count AND i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) END FROM design_tickets d WHERE d.sample_request_id = s.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS dummy_paid, (SELECT m.status FROM production_mou m WHERE m.sample_request_id = s.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) IN ('REJECTED', 'CANCELLED') AS mou_closed, (SELECT b.material_status FROM production_batches b WHERE b.sample_request_id = s.id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS batch_material, (SELECT b.sched_packing_on FROM production_batches b WHERE b.sample_request_id = s.id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS batch_packing_on, (SELECT b.stages_done FROM production_batches b WHERE b.sample_request_id = s.id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1) AS batch_stages, (SELECT h.status FROM shipments h WHERE h.sample_request_id = s.id AND h.status <> 'CANCELLED' ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1) AS shipment_status FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id LEFT JOIN master_operator o ON o.id = s.pic_crm_id";

/// Satu harga per simpan (v2.2), hanya-tambah. ?1 id, ?2 tiket, ?3 iterasi,
/// ?4-?7 komponen, ?8 HPP, ?9 margin, ?10 harga jual, ?11 catatan,
/// ?12 pencatat, ?13 waktu.
pub const PRICE_INSERT_SQL: &str = "INSERT INTO pricing_formulas (id, sample_request_id, iteration_number, raw_material_cost_idr, packaging_cost_idr, operational_cost_idr, regulatory_cost_idr, hpp_unit_idr, margin_bp, final_unit_price_idr, notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

pub const PRICES_SQL: &str = "SELECT p.*, o.nama_operator AS recorded_by_name FROM pricing_formulas p LEFT JOIN master_operator o ON o.id = p.recorded_by WHERE p.sample_request_id = ?1 ORDER BY p.iteration_number, p.recorded_at, p.rowid;";

/// Padanan `PRICE_COST_COLUMNS`: hanya untuk pemegang `pricing.view`.
pub const PRICE_COST_COLUMNS: &[&str] = &[
    "raw_material_cost_idr",
    "packaging_cost_idr",
    "operational_cost_idr",
    "regulatory_cost_idr",
    "hpp_unit_idr",
    "margin_bp",
];

/// Satu baris per sampel yang selesai dibuat RnD (v2.1), hanya-tambah.
/// ?1 id, ?2 tiket, ?3 iterasi, ?4 formula code, ?5 product knowledge,
/// ?6 catatan langkah, ?7 pencatat, ?8 waktu.
pub const SAMPLE_FORMULA_INSERT_SQL: &str = "INSERT INTO sample_formulas (id, sample_request_id, iteration_number, formula_code, product_knowledge, rnd_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

pub const SAMPLE_FORMULAS_SQL: &str = "SELECT f.*, o.nama_operator AS recorded_by_name FROM sample_formulas f LEFT JOIN master_operator o ON o.id = f.recorded_by WHERE f.sample_request_id = ?1 ORDER BY f.iteration_number, f.recorded_at;";

/// Tiket lain yang memakai formula code yang sama (kode tidak unik).
pub const SAMPLE_FORMULA_MATCHES_SQL: &str = "SELECT DISTINCT f.formula_code, s.id AS sample_request_id, s.brand_name, s.status, c.client_code FROM sample_formulas f JOIN sample_requests s ON s.id = f.sample_request_id LEFT JOIN clients c ON c.id = s.client_id WHERE f.sample_request_id <> ?1 AND f.formula_code COLLATE NOCASE IN (SELECT formula_code FROM sample_formulas WHERE sample_request_id = ?1) ORDER BY f.formula_code, s.id LIMIT 20;";

/// Pesan konflik saat perangkat lain sudah mengubah tiket lebih dulu.
pub const SAMPLE_CHANGED_ELSEWHERE: &str =
    "This sample request was changed on another device first. Sync, check its current status, then record the step again.";

// ---------------------------------------------------------------------------
// Foto (PRD FR-07). Padanan `src/lib/validations/media.ts`, vektor kembar.
// Kompresi dikerjakan webview; di sini hanya pemeriksaan ulang hasilnya.
// ---------------------------------------------------------------------------

pub const SAMPLE_MEDIA_PURPOSES: &[&str] =
    &["REFERENCE", "PAYMENT_PROOF", "MOCKUP", "CLIENT_RESPONSE", "LEGAL_DOCUMENT", "DUMMY_ARTWORK", "SHIPMENT_PROOF"];

/// Padanan `mediaPurposePermission`: mockup milik desainer (v2.4).
pub fn media_purpose_permission(purpose: &str) -> &'static str {
    if purpose == "SHIPMENT_PROOF" {
        "shipping.manage"
    } else if purpose == "MOCKUP" || purpose == "DUMMY_ARTWORK" {
        "design.manage"
    } else {
        "samples.manage"
    }
}
pub const MEDIA_MIME: &str = "image/webp";
pub const MEDIA_MAX_BYTES: usize = 307_200;
pub const MEDIA_TOO_LARGE: &str =
    "The image is still over 300 KB after compression. Crop the parts you do not need, then upload it again.";
pub const MEDIA_NOT_WEBP: &str = "The photo is not a valid WebP image.";
pub const MEDIA_PURPOSE_INVALID: &str = "Choose what the photo is for.";

/// Sisipkan satu foto (hanya-tambah), dipakai cloud, SQLite lokal, dan Web
/// (`MEDIA_INSERT_SQL` di `media.ts`, WAJIB identik). ?1 id, ?2 id tiket,
/// ?3 jenis, ?4 ukuran, ?5 data base64, ?6 pengunggah, ?7 waktu.
pub const MEDIA_INSERT_SQL: &str = "INSERT INTO media_asset (id, owner_type, owner_id, purpose, mime, byte_size, data_base64, created_by, created_at) VALUES (?1, 'sample', ?2, ?3, 'image/webp', ?4, ?5, ?6, ?7) ON CONFLICT(id) DO NOTHING;";

/// Padanan `validateMediaUpload`: jenis sah, base64 standar ketat, WebP
/// sungguhan (`RIFF....WEBP`), paling besar `MEDIA_MAX_BYTES`. Mengembalikan
/// ukuran biner.
pub fn validate_media_upload(purpose: &str, data_base64: &str) -> Result<usize, &'static str> {
    use base64::Engine as _;
    if !SAMPLE_MEDIA_PURPOSES.contains(&purpose) {
        return Err(MEDIA_PURPOSE_INVALID);
    }
    // Ukuran dihitung dari panjang teks dulu, supaya kiriman raksasa ditolak
    // sebelum didekode ke memori.
    if data_base64.is_empty() || data_base64.len() % 4 != 0 {
        return Err(MEDIA_NOT_WEBP);
    }
    let padding = data_base64.bytes().rev().take_while(|byte| *byte == b'=').count();
    let size = data_base64.len() / 4 * 3 - padding.min(2);
    if size > MEDIA_MAX_BYTES {
        return Err(MEDIA_TOO_LARGE);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| MEDIA_NOT_WEBP)?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(MEDIA_NOT_WEBP);
    }
    Ok(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/sample.test.ts`.

    fn settings(values: &[(&str, &str)]) -> BusinessSettings {
        read_business_settings(
            &values
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn setelan_bisnis_dibaca_dengan_bawaan() {
        assert_eq!(settings(&[]), BusinessSettings::default());
        assert_eq!(
            settings(&[
                ("default_free_revision_limit", "2"),
                ("sample_fee_mode", "PAID"),
                ("lead_hot_max_days", "5"),
                ("lead_warm_max_days", "14"),
                ("max_photos_per_sample", "5"),
                ("telegram_chat_id_cs", " -1001234567890 "),
                ("telegram_chat_id_rnd", "@maklon_rnd"),
                ("telegram_chat_id_finance", "finance group"),
                ("offline_login_max_days", "3"),
                ("default_sample_fee_idr", "150000"),
                ("default_test_fee_idr", "1500000000"),
                ("invoice_due_days", "14"),
                ("invoice_payment_instructions", " BCA 123 a.n. Company "),
                ("telegram_chat_id_design", "@maklon_design"),
                ("telegram_chat_id_production", "@maklon_production"),
                ("default_dummy_fee_idr", "75000"),
                ("max_dummy_rejections", "3"),
                ("storage_grace_days", "21"),
                ("storage_fee_idr", "500"),
                ("dp_percentage_bp", "3000"),
                ("approval_web_url", " https://crm.company.id/ "),
                ("approval_token_ttl_days", "7"),
            ]),
            BusinessSettings {
                default_free_revision_limit: 2,
                sample_fee_mode: "PAID",
                lead_hot_max_days: 5,
                lead_warm_max_days: 14,
                max_photos_per_sample: 5,
                telegram_chat_id_cs: "-1001234567890".into(),
                telegram_chat_id_rnd: "@maklon_rnd".into(),
                telegram_chat_id_finance: String::new(),
                offline_login_max_days: 3,
                default_sample_fee_idr: 150_000,
                default_test_fee_idr: 1_500_000_000,
                invoice_due_days: 14,
                invoice_payment_instructions: "BCA 123 a.n. Company".into(),
                storage_sop_text: String::new(),
                telegram_chat_id_design: "@maklon_design".into(),
                telegram_chat_id_production: "@maklon_production".into(),
                default_dummy_fee_idr: 75_000,
                max_dummy_rejections: 3,
                storage_grace_days: 21,
                storage_fee_idr: 500,
                dp_percentage_bp: 3000,
                approval_web_url: "https://crm.company.id".into(),
                approval_token_ttl_days: 7,
            }
        );
        assert_eq!(
            settings(&[
                ("default_free_revision_limit", "99"),
                ("sample_fee_mode", "paid"),
                ("lead_hot_max_days", "9"),
                ("lead_warm_max_days", "9"),
                ("max_photos_per_sample", "0"),
                ("offline_login_max_days", "9"),
                ("max_dummy_rejections", "21"),
                ("storage_grace_days", "91"),
                ("storage_fee_idr", "-1"),
                ("dp_percentage_bp", "0"),
                ("approval_web_url", "http://crm.company.id"),
                ("approval_token_ttl_days", "31"),
            ]),
            BusinessSettings::default()
        );
    }

    #[test]
    fn alamat_web_persetujuan_dinormalkan() {
        let cases: &[(&str, Option<&str>)] = &[
            ("", Some("")),
            ("  ", Some("")),
            ("https://crm.company.id", Some("https://crm.company.id")),
            ("https://crm.company.id/", Some("https://crm.company.id")),
            ("https://10.0.0.5:3000/maklon/", Some("https://10.0.0.5:3000/maklon")),
            ("http://crm.company.id", None),
            ("https://", None),
            ("https://crm.company.id:abc", None),
            ("https://crm.company.id:1:2", None),
            ("https://crm.company.id/a?b=1", None),
            ("https://user@crm.company.id", None),
        ];
        for (value, expected) in cases {
            assert_eq!(normalize_approval_web_url(value).as_deref(), *expected, "{value}");
        }
        assert_eq!(normalize_approval_web_url(&format!("https://{}.id", "a".repeat(200))), None);
    }

    #[test]
    fn tenggat_login_offline_mengikuti_setelan_terpendek() {
        let day = 86_400;
        // Login online pada t=0 dengan batas build 7 hari.
        assert_eq!(offline_login_deadline(0, 7 * day, 7), 7 * day);
        // Setelan diperpendek menjadi 3 hari: berlaku untuk snapshot yang sudah ada.
        assert_eq!(offline_login_deadline(0, 7 * day, 3), 3 * day);
        // Setelan tidak pernah melewati batas yang dicatat saat login online.
        assert_eq!(offline_login_deadline(0, 2 * day, 7), 2 * day);
    }

    #[test]
    fn setelan_bisnis_divalidasi() {
        let valid = json!({
            "default_free_revision_limit": 0,
            "sample_fee_mode": "FREE",
            "lead_hot_max_days": 0,
            "lead_warm_max_days": 1,
            "max_photos_per_sample": 1,
            "telegram_chat_id_cs": "",
            "telegram_chat_id_rnd": "12345",
            "telegram_chat_id_finance": "@finance_team",
            "offline_login_max_days": 1,
            "default_sample_fee_idr": 0,
            "default_test_fee_idr": 250000,
            "invoice_due_days": 0,
            "invoice_payment_instructions": " Transfer to BCA ",
            "storage_sop_text": " Keep below 25°C ",
            "telegram_chat_id_design": "",
            "telegram_chat_id_production": "",
            "default_dummy_fee_idr": 50000,
            "max_dummy_rejections": 2,
            "storage_grace_days": 0,
            "storage_fee_idr": 2500,
            "dp_percentage_bp": 10000,
            "approval_web_url": "",
            "approval_token_ttl_days": 30,
        });
        assert_eq!(
            validate_business_settings(&valid),
            Ok(BusinessSettings {
                default_free_revision_limit: 0,
                sample_fee_mode: "FREE",
                lead_hot_max_days: 0,
                lead_warm_max_days: 1,
                max_photos_per_sample: 1,
                telegram_chat_id_cs: String::new(),
                telegram_chat_id_rnd: "12345".into(),
                telegram_chat_id_finance: "@finance_team".into(),
                offline_login_max_days: 1,
                default_sample_fee_idr: 0,
                default_test_fee_idr: 250_000,
                invoice_due_days: 0,
                invoice_payment_instructions: "Transfer to BCA".into(),
                storage_sop_text: "Keep below 25°C".into(),
                telegram_chat_id_design: String::new(),
                telegram_chat_id_production: String::new(),
                default_dummy_fee_idr: 50_000,
                max_dummy_rejections: 2,
                storage_grace_days: 0,
                storage_fee_idr: 2500,
                dp_percentage_bp: 10_000,
                approval_web_url: String::new(),
                approval_token_ttl_days: 30,
            })
        );
        let with = |key: &str, value: Value| {
            let mut draft = valid.clone();
            draft[key] = value;
            validate_business_settings(&draft).unwrap_err()
        };
        assert_eq!(with("default_free_revision_limit", json!(21)), "Free revisions must be a whole number from 0 to 20.");
        assert_eq!(with("default_free_revision_limit", json!(1.5)), "Free revisions must be a whole number from 0 to 20.");
        assert_eq!(with("sample_fee_mode", json!("SOMETIMES")), "Choose how sample fees are charged.");
        assert_eq!(with("default_sample_fee_idr", json!(-1)), "Default fees must be whole rupiah amounts.");
        assert_eq!(with("default_test_fee_idr", Value::Null), "Default fees must be whole rupiah amounts.");
        assert_eq!(with("default_dummy_fee_idr", json!(-5)), "Default fees must be whole rupiah amounts.");
        assert_eq!(with("telegram_chat_id_design", Value::Null), TELEGRAM_CHAT_ID_INVALID);
        assert_eq!(with("telegram_chat_id_production", Value::Null), TELEGRAM_CHAT_ID_INVALID);
        assert_eq!(with("storage_grace_days", json!(91)), "The free storage period must be a whole number of days from 0 to 90.");
        assert_eq!(with("storage_fee_idr", json!(-1)), "The storage fee must be a whole rupiah amount.");
        for limit in [json!(21), json!(-1), json!("2")] {
            assert_eq!(
                with("max_dummy_rejections", limit),
                "The dummy rejection limit must be a whole number from 0 to 20."
            );
        }
        for dp in [json!(0), json!(10_001), json!("50")] {
            assert_eq!(with("dp_percentage_bp", dp), DP_PERCENTAGE_INVALID);
        }
        for url in [json!("http://crm.company.id"), Value::Null, json!("https://crm company.id")] {
            assert_eq!(with("approval_web_url", url), APPROVAL_WEB_URL_INVALID);
        }
        for ttl in [json!(0), json!(31), json!("3")] {
            assert_eq!(with("approval_token_ttl_days", ttl), APPROVAL_TTL_INVALID);
        }
        assert_eq!(with("invoice_payment_instructions", Value::Null), PAYMENT_INSTRUCTIONS_INVALID);
        assert_eq!(with("storage_sop_text", json!("x".repeat(2001))), STORAGE_SOP_INVALID);
        assert_eq!(with("invoice_payment_instructions", json!("x".repeat(1001))), PAYMENT_INSTRUCTIONS_INVALID);
        assert_eq!(
            with("invoice_due_days", json!(91)),
            "The invoice due period must be a whole number of days from 0 to 90."
        );
        assert_eq!(with("lead_hot_max_days", json!(61)), "The Hot limit must be a whole number of days from 0 to 60.");
        assert_eq!(
            with("lead_warm_max_days", json!(181)),
            "The Warm limit must be more days than the Hot limit, up to 180."
        );
        assert_eq!(
            with("max_photos_per_sample", json!(51)),
            "Photos per sample request must be a whole number from 1 to 50."
        );
        assert_eq!(
            with("max_photos_per_sample", json!(0)),
            "Photos per sample request must be a whole number from 1 to 50."
        );
        assert_eq!(with("telegram_chat_id_cs", json!("@abc")), TELEGRAM_CHAT_ID_INVALID);
        assert_eq!(with("telegram_chat_id_rnd", json!("12-34")), TELEGRAM_CHAT_ID_INVALID);
        assert_eq!(with("telegram_chat_id_finance", Value::Null), TELEGRAM_CHAT_ID_INVALID);
        for days in [json!(0), json!(8), json!("3")] {
            assert_eq!(
                with("offline_login_max_days", days),
                "The offline sign-in period must be a whole number of days from 1 to 7."
            );
        }
        let mut same = valid.clone();
        same["lead_hot_max_days"] = json!(5);
        same["lead_warm_max_days"] = json!(5);
        assert_eq!(
            validate_business_settings(&same).unwrap_err(),
            "The Warm limit must be more days than the Hot limit, up to 180."
        );
    }

    #[test]
    fn aksi_tiket_mengikuti_diagram_dan_gerbang_kuota() {
        type Expected = Result<(&'static str, i64, Option<bool>, Option<&'static str>), &'static str>;
        let not_allowed: Expected = Err(SAMPLE_STEP_NOT_ALLOWED);
        let cases: &[(&str, bool, i64, i64, &str, Option<i64>, Expected)] = &[
            ("DRAFT", false, 0, 1, "SUBMIT_TO_RND", None, Ok(("RND_REVIEW", 0, None, None))),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", Some(14), Ok(("RND_ACCEPTED", 0, None, None))),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", None, Err("Enter the RnD lead time in days (1-365).")),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", Some(366), Err("Enter the RnD lead time in days (1-365).")),
            ("RND_REVIEW", false, 0, 1, "RND_REJECT", None, Ok(("RND_REJECTED", 0, None, None))),
            ("RND_ACCEPTED", true, 0, 1, "PROCEED", None, Ok(("WAITING_SAMPLE_PAYMENT", 0, None, None))),
            ("RND_ACCEPTED", false, 0, 1, "PROCEED", None, Ok(("IN_RND", 0, None, None))),
            ("WAITING_SAMPLE_PAYMENT", true, 0, 1, "PAYMENT_RECEIVED", None, Ok(("IN_RND", 0, None, None))),
            ("WAITING_REVISION_PAYMENT", true, 2, 1, "PAYMENT_RECEIVED", None, Ok(("IN_RND", 2, None, None))),
            ("IN_RND", false, 0, 1, "SAMPLE_READY", None, Ok(("SAMPLE_READY", 0, None, None))),
            ("SAMPLE_READY", false, 0, 1, "SAMPLE_SENT", None, Ok(("SAMPLE_SENT", 0, None, None))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_ACC", None, Ok(("CLIENT_ACC", 0, None, Some("ACC")))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_REJECT", None, Ok(("CLIENT_REJECT", 0, None, Some("REJECT")))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_REVISE", None, Ok(("IN_RND", 1, Some(false), Some("REVISE")))),
            ("SAMPLE_SENT", false, 1, 1, "CLIENT_REVISE", None, Ok(("PENDING_FEE_ASSESSMENT", 2, Some(true), Some("REVISE")))),
            ("SAMPLE_SENT", false, 0, 0, "CLIENT_REVISE", None, Ok(("PENDING_FEE_ASSESSMENT", 1, Some(true), Some("REVISE")))),
            ("PENDING_FEE_ASSESSMENT", false, 2, 1, "CANCEL", None, Ok(("CANCELLED", 2, None, None))),
            ("DRAFT", false, 0, 1, "CANCEL", None, Ok(("CANCELLED", 0, None, None))),
            ("DRAFT", false, 0, 1, "SAMPLE_SENT", None, not_allowed),
            ("IN_RND", false, 0, 1, "CLIENT_REVISE", None, not_allowed),
            ("PENDING_FEE_ASSESSMENT", false, 2, 1, "PAYMENT_RECEIVED", None, not_allowed),
            ("CLIENT_ACC", false, 0, 1, "CANCEL", None, not_allowed),
            ("CANCELLED", false, 0, 1, "CANCEL", None, not_allowed),
            ("UNKNOWN", false, 0, 1, "CANCEL", None, not_allowed),
        ];
        for (status, paid, index, limit, action, lead, expected) in cases {
            let state = SampleActionState {
                status,
                is_paid_sample: *paid,
                revision_index: *index,
                free_revision_limit: *limit,
                has_price: true,
                fee_paid: true,
                test_ready: true,
                mockup_ready: true,
            };
            let actual = apply_sample_action(&state, action, *lead, None)
                .map(|result| (result.status, result.revision_index, result.is_billable, result.client_decision));
            assert_eq!(actual, *expected, "{status} + {action}");
        }
    }

    #[test]
    fn tarif_revisi_dan_gerbang_harga() {
        let state = |status: &'static str, has_price: bool| SampleActionState {
            status,
            is_paid_sample: false,
            revision_index: 2,
            free_revision_limit: 1,
            has_price,
            fee_paid: true,
            test_ready: true,
            mockup_ready: true,
        };
        type Expected = Result<(&'static str, i64, Option<bool>), &'static str>;
        let cases: &[(&'static str, bool, &str, Option<i64>, Expected)] = &[
            ("SAMPLE_READY", false, "SAMPLE_SENT", None, Err(SAMPLE_NOT_PRICED)),
            ("SAMPLE_READY", true, "SAMPLE_SENT", None, Ok(("SAMPLE_SENT", 2, None))),
            ("DRAFT", false, "SAMPLE_SENT", None, Err(SAMPLE_STEP_NOT_ALLOWED)),
            ("PENDING_FEE_ASSESSMENT", false, "SET_REVISION_FEE", Some(750_000), Ok(("WAITING_REVISION_PAYMENT", 2, None))),
            ("PENDING_FEE_ASSESSMENT", false, "SET_REVISION_FEE", Some(0), Ok(("IN_RND", 2, Some(false)))),
            ("PENDING_FEE_ASSESSMENT", false, "SET_REVISION_FEE", Some(-1), Err(REVISION_FEE_INVALID)),
            ("PENDING_FEE_ASSESSMENT", false, "SET_REVISION_FEE", None, Err(REVISION_FEE_INVALID)),
            ("IN_RND", false, "SET_REVISION_FEE", Some(1000), Err(SAMPLE_STEP_NOT_ALLOWED)),
        ];
        for (status, has_price, action, fee, expected) in cases {
            let actual = apply_sample_action(&state(status, *has_price), action, None, *fee)
                .map(|result| (result.status, result.revision_index, result.is_billable));
            assert_eq!(actual, *expected, "{status} + {action} {fee:?}");
        }
    }

    #[test]
    fn gerbang_tagihan_lunas() {
        let state = |status: &'static str, fee_paid: bool, test_ready: bool| SampleActionState {
            status,
            is_paid_sample: true,
            revision_index: 1,
            free_revision_limit: 0,
            has_price: true,
            fee_paid,
            test_ready,
            mockup_ready: true,
        };
        type Expected = Result<&'static str, &'static str>;
        let cases: &[(&'static str, bool, bool, &str, Expected)] = &[
            ("WAITING_SAMPLE_PAYMENT", false, true, "PAYMENT_RECEIVED", Err(SAMPLE_FEE_UNPAID)),
            ("WAITING_SAMPLE_PAYMENT", true, true, "PAYMENT_RECEIVED", Ok("IN_RND")),
            ("WAITING_REVISION_PAYMENT", false, true, "PAYMENT_RECEIVED", Err(SAMPLE_FEE_UNPAID)),
            ("IN_RND", false, true, "PAYMENT_RECEIVED", Err(SAMPLE_STEP_NOT_ALLOWED)),
            ("SAMPLE_READY", true, false, "SAMPLE_SENT", Err(SAMPLE_TEST_UNPAID)),
            ("SAMPLE_READY", true, true, "SAMPLE_SENT", Ok("SAMPLE_SENT")),
        ];
        let no_mockup = SampleActionState { mockup_ready: false, ..state("SAMPLE_READY", true, true) };
        assert_eq!(apply_sample_action(&no_mockup, "SAMPLE_SENT", None, None), Err(SAMPLE_MOCKUP_MISSING));
        for (status, fee_paid, test_ready, action, expected) in cases {
            let actual = apply_sample_action(&state(status, *fee_paid, *test_ready), action, None, None)
                .map(|result| result.status);
            assert_eq!(actual, *expected, "{status} + {action}");
        }
        let testing = json!({
            "product_category_option_id": "cat-1", "sample_qty": 1, "brand_name": "A",
            "packaging": "P", "deadline_at": "2026-10-31", "ship_to_address": "Jl. A",
            "is_dummy_required": false, "is_paid_sample": true, "is_test_requested": true,
        });
        assert_eq!(validate_sample_draft(&testing, "PER_REQUEST").unwrap()["is_test_requested"], json!(true));
        let mut wrong = testing.clone();
        wrong["is_test_requested"] = json!("yes");
        assert_eq!(validate_sample_draft(&wrong, "PER_REQUEST").unwrap_err(), "Choose whether the sample is tested.");
    }

    #[test]
    fn harga_satuan_dan_format_rupiah() {
        let price = |raw: Value, packaging: Value, operational: Value, regulatory: Value, margin: Value| {
            compute_unit_price(&json!({
                "raw_material_cost_idr": raw,
                "packaging_cost_idr": packaging,
                "operational_cost_idr": operational,
                "regulatory_cost_idr": regulatory,
                "margin_bp": margin,
                "notes": " 10k pcs ",
            }))
            .map(|price| (price.hpp_unit_idr, price.final_unit_price_idr, price.notes))
        };
        let ok = |hpp: i64, final_price: i64| Ok((hpp, final_price, "10k pcs".to_owned()));
        assert_eq!(price(json!(8420), json!(7850), json!(2450), json!(780), json!(4000)), ok(19_500, 32_500));
        assert_eq!(price(json!(100), json!(0), json!(0), json!(0), json!(3333)), ok(100, 150));
        assert_eq!(price(json!(1), json!(0), json!(0), json!(0), json!(0)), ok(1, 1));
        assert_eq!(price(json!(19_500), json!(0), json!(0), json!(0), json!(9500)), ok(19_500, 390_000));
        let cost_error = Err("Each cost must be a whole rupiah amount per unit.");
        assert_eq!(price(json!(-1), json!(0), json!(0), json!(0), json!(0)), cost_error);
        assert_eq!(price(json!(1.5), json!(0), json!(0), json!(0), json!(0)), cost_error);
        assert_eq!(price(json!("100"), json!(0), json!(0), json!(0), json!(0)), cost_error);
        assert_eq!(price(json!(1), json!(0), json!(0), Value::Null, json!(0)), cost_error);
        assert_eq!(price(json!(0), json!(0), json!(0), json!(0), json!(0)), Err("Enter at least one cost."));
        assert_eq!(price(json!(1), json!(0), json!(0), json!(0), json!(9501)), Err("The margin must be from 0% to 95%."));
        assert_eq!(price(json!(1), json!(0), json!(0), json!(0), Value::Null), Err("The margin must be from 0% to 95%."));
        let long_notes = json!({
            "raw_material_cost_idr": 1, "packaging_cost_idr": 0, "operational_cost_idr": 0,
            "regulatory_cost_idr": 0, "margin_bp": 0, "notes": "n".repeat(1001),
        });
        assert_eq!(compute_unit_price(&long_notes), Err("Notes are up to 1000 characters."));

        for (value, text) in [(0, "Rp 0"), (500, "Rp 500"), (32_500, "Rp 32.500"), (1_234_567, "Rp 1.234.567"), (-5000, "-Rp 5.000")] {
            assert_eq!(format_rupiah(value), text);
        }
    }

    #[test]
    fn izin_langkah_dan_isian_rnd() {
        for (action, permission) in [
            ("RND_ACCEPT", "rnd.manage"),
            ("RND_REJECT", "rnd.manage"),
            ("SAMPLE_READY", "rnd.manage"),
            ("PAYMENT_RECEIVED", "finance.manage"),
            ("SET_REVISION_FEE", "finance.manage"),
            ("SUBMIT_TO_RND", "samples.manage"),
            ("UNKNOWN", "samples.manage"),
        ] {
            assert_eq!(sample_action_permission(action), permission, "{action}");
        }

        let step = |class: Option<&'static str>, reason: Option<&str>, code: Option<&str>, knowledge: Option<&str>| RndStep {
            product_class: class,
            reject_reason_option_id: reason.map(str::to_owned),
            formula_code: code.map(str::to_owned),
            product_knowledge: knowledge.map(str::to_owned),
        };
        let long_code = "F".repeat(61);
        let long_knowledge = "k".repeat(2001);
        let cases: Vec<(&str, Value, Result<RndStep, &str>)> = vec![
            ("RND_ACCEPT", json!({ "product_class": "NEW" }), Ok(step(Some("NEW"), None, None, None))),
            ("RND_ACCEPT", json!({ "product_class": " EXISTING " }), Ok(step(Some("EXISTING"), None, None, None))),
            ("RND_ACCEPT", json!({ "product_class": "new" }), Err("Choose whether this is a new or an existing product.")),
            ("RND_ACCEPT", json!({}), Err("Choose whether this is a new or an existing product.")),
            ("RND_REJECT", json!({ "reject_reason_option_id": "r1" }), Ok(step(None, Some("r1"), None, None))),
            (
                "RND_REJECT",
                json!({ "product_class": "NEW", "reject_reason_option_id": "r1" }),
                Ok(step(Some("NEW"), Some("r1"), None, None)),
            ),
            (
                "RND_REJECT",
                json!({ "product_class": "OLD", "reject_reason_option_id": "r1" }),
                Err("Choose whether this is a new or an existing product."),
            ),
            ("RND_REJECT", json!({ "product_class": "NEW" }), Err("Choose the reason RnD rejected the request.")),
            (
                "SAMPLE_READY",
                json!({ "formula_code": " FRM-001 ", "product_knowledge": "Gel, pH 5.5" }),
                Ok(step(None, None, Some("FRM-001"), Some("Gel, pH 5.5"))),
            ),
            (
                "SAMPLE_READY",
                json!({ "product_knowledge": "Gel" }),
                Err("Enter the formula code, up to 60 characters."),
            ),
            (
                "SAMPLE_READY",
                json!({ "formula_code": long_code, "product_knowledge": "Gel" }),
                Err("Enter the formula code, up to 60 characters."),
            ),
            (
                "SAMPLE_READY",
                json!({ "formula_code": "FRM-001", "product_knowledge": long_knowledge }),
                Err("Enter the product knowledge, up to 2000 characters."),
            ),
            ("SAMPLE_SENT", json!({ "product_class": "NEW", "formula_code": "X" }), Ok(RndStep::default())),
        ];
        for (action, input, expected) in cases {
            assert_eq!(validate_rnd_step(action, Some(&input)), expected, "{action} {input}");
        }
        assert_eq!(
            validate_rnd_step("RND_ACCEPT", None),
            Err("Choose whether this is a new or an existing product.")
        );
    }

    #[test]
    fn draft_tiket_dirapikan_dan_divalidasi() {
        let draft = json!({
            "product_category_option_id": "cat-1",
            "sample_qty": 3,
            "brand_name": " Aura Glow ",
            "packaging": "Amber dropper 30 ml",
            "deadline_at": "2026-10-31",
            "ship_to_address": "Jl. Merdeka 1, Bandung",
            "is_dummy_required": false,
            "is_paid_sample": true,
            "special_requests": { "color": "Clear", "aroma": "Rose", "extra": "ignored" },
            "client_budget_idr": 2500000,
        });
        assert_eq!(
            validate_sample_draft(&draft, "PER_REQUEST").unwrap(),
            json!({
                "product_category_option_id": "cat-1",
                "sample_kind_option_id": "",
                "formulation_type_option_id": "",
                "registration_category_option_id": "",
                "pic_crm_id": null,
                "sample_qty": 3,
                "brand_name": "Aura Glow",
                "bpom_product_name": "",
                "claims": "",
                "packaging": "Amber dropper 30 ml",
                "reference_notes": "",
                "client_budget_idr": 2500000,
                "special_requests_json": "{\"color\":\"Clear\",\"texture\":\"\",\"size\":\"\",\"aroma\":\"Rose\"}",
                "deadline_at": "2026-10-31",
                "ship_to_address": "Jl. Merdeka 1, Bandung",
                "is_dummy_required": false,
                "is_paid_sample": true,
                "is_test_requested": false,
            })
        );

        let mut unset = draft.clone();
        unset.as_object_mut().unwrap().remove("is_paid_sample");
        assert_eq!(validate_sample_draft(&unset, "FREE").unwrap()["is_paid_sample"], json!(false));
        assert_eq!(validate_sample_draft(&unset, "PAID").unwrap()["is_paid_sample"], json!(true));
        assert_eq!(
            validate_sample_draft(&draft, "FREE").unwrap_err(),
            "Company settings make every sample free."
        );

        let cases: &[(&str, Value, &str)] = &[
            ("product_category_option_id", json!(""), "Choose the product type."),
            ("sample_qty", json!(0), "Enter the sample quantity (1-10000)."),
            ("sample_qty", json!("3"), "Enter the sample quantity (1-10000)."),
            ("brand_name", json!("  "), "The brand name is required, up to 120 characters."),
            ("packaging", json!(""), "The packaging is required, up to 300 characters."),
            ("deadline_at", json!("2026-02-30"), "Enter the date the sample must reach the client."),
            ("ship_to_address", json!(""), "The shipping address is required, up to 300 characters."),
            ("is_dummy_required", json!("no"), "Choose whether a packaging dummy is needed."),
            ("client_budget_idr", json!(10.5), "The client budget must be a whole rupiah amount."),
            ("client_budget_idr", json!(-1), "The client budget must be a whole rupiah amount."),
            ("pic_crm_id", json!(-4), "Choose an active CRM operator."),
            ("is_paid_sample", Value::Null, "Choose whether this sample is paid."),
        ];
        for (key, value, message) in cases {
            let mut changed = draft.clone();
            changed[*key] = value.clone();
            assert_eq!(validate_sample_draft(&changed, "PER_REQUEST").unwrap_err(), *message, "{key}");
        }
    }

    #[test]
    fn media_upload_divalidasi() {
        use base64::Engine as _;
        const TINY_WEBP: &str = "UklGRgwAAABXRUJQVlA4TA==";
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";
        let cases: &[(&str, &str, Result<usize, &str>)] = &[
            ("REFERENCE", TINY_WEBP, Ok(16)),
            ("PAYMENT_PROOF", TINY_WEBP, Ok(16)),
            ("MOCKUP", TINY_WEBP, Ok(16)),
            ("CLIENT_RESPONSE", TINY_WEBP, Ok(16)),
            ("LEGAL_DOCUMENT", TINY_WEBP, Ok(16)),
            ("DUMMY_ARTWORK", TINY_WEBP, Ok(16)),
            ("INVOICE", TINY_WEBP, Err(MEDIA_PURPOSE_INVALID)),
            ("REFERENCE", PNG, Err(MEDIA_NOT_WEBP)),
            ("REFERENCE", "not base64!", Err(MEDIA_NOT_WEBP)),
            ("REFERENCE", "UklGRgwAAABXRUJQVlA4TA", Err(MEDIA_NOT_WEBP)),
            ("REFERENCE", "", Err(MEDIA_NOT_WEBP)),
            ("REFERENCE", "UklGRg==", Err(MEDIA_NOT_WEBP)),
        ];
        for (purpose, data, expected) in cases {
            assert_eq!(validate_media_upload(purpose, data), *expected, "{purpose} {data}");
        }
        let webp_of = |size: usize| {
            let mut raw = vec![0u8; size];
            raw[..12].copy_from_slice(b"RIFF\0\0\0\0WEBP");
            base64::engine::general_purpose::STANDARD.encode(raw)
        };
        assert_eq!(validate_media_upload("REFERENCE", &webp_of(MEDIA_MAX_BYTES)), Ok(MEDIA_MAX_BYTES));
        assert_eq!(validate_media_upload("REFERENCE", &webp_of(MEDIA_MAX_BYTES + 1)), Err(MEDIA_TOO_LARGE));
    }

    #[test]
    fn tanggal_kalender() {
        assert!(is_calendar_date("2028-02-29"));
        assert!(!is_calendar_date("2026-02-29"));
        assert!(!is_calendar_date("2026-13-01"));
        assert!(!is_calendar_date("26-01-01"));
    }
}
