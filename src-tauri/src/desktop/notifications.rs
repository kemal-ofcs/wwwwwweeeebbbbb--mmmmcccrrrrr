//! Notifikasi divisi (PRD FR-08): satu kejadian tampil di lonceng aplikasi dan,
//! bila bot aktif dan chat ID divisinya terisi, dikirim ke grup Telegram.
//!
//! WAJIB identik dengan `src/lib/validations/notification.ts` (aturan murni dan
//! SQL) dan `src/lib/server/notifications.ts` (alur kirim). Vektor kembar ada
//! di `mod tests` di sini dan di `notification.test.ts`; setiap konstanta SQL
//! dites ada per karakter di berkas ini, karena baris yang sama diklaim dan
//! dikirim Web maupun perangkat.
//!
//! Tabelnya cloud-only. Baris lahir di transaksi cloud yang sama dengan
//! mutasinya (handler push di `turso.rs`, atau transaksi Web), jadi event yang
//! ditolak sebagai konflik tidak pernah menghasilkan notifikasi.

use std::collections::HashMap;

use reqwest::Client;
use serde_json::{json, Value};

use super::clients::{
    company_day_bounds_utc, parse_stored_timestamp, timezone_offset_hours, utc_timestamp,
};
use super::models::CommandError;
use super::samples::{self, BusinessSettings};
use super::turso::{Statement, TursoClient};

pub const NOTIFICATION_DIVISIONS: &[&str] = &["CS", "RND", "FINANCE"];
pub const NOTIFICATION_MAX_ATTEMPTS: i64 = 5;
pub const COLD_DIGEST_HOUR: i64 = 8;
pub const COLD_DIGEST_MAX_CATCH_UP_DAYS: i64 = 7;

/// Izin lonceng per divisi; cermin `NOTIFICATION_PERMISSIONS`.
pub fn division_permission(division: &str) -> Option<&'static str> {
    match division {
        "CS" => Some("notifications_cs.view"),
        "RND" => Some("notifications_rnd.view"),
        "FINANCE" => Some("notifications_finance.view"),
        _ => None,
    }
}

/// Padanan `retryDelayMinutes`: jeda setelah `attempts` percobaan gagal;
/// `None` = berhenti (`FAILED`).
pub fn retry_delay_minutes(attempts: i64) -> Option<i64> {
    if attempts >= NOTIFICATION_MAX_ATTEMPTS {
        return None;
    }
    Some(match attempts {
        ..=1 => 1,
        2 => 5,
        3 => 15,
        _ => 60,
    })
}

/// Padanan `isTelegramBotToken`: `<3-20 digit>:<30-64 karakter A-Za-z0-9_->`.
pub fn is_telegram_bot_token(value: &str) -> bool {
    let Some((id, secret)) = value.trim().split_once(':') else {
        return false;
    };
    (3..=20).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && (30..=64).contains(&secret.len())
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub const TELEGRAM_TOKEN_REQUIRED: &str =
    "Enter the bot token from @BotFather to turn notifications on.";
pub const TELEGRAM_TOKEN_INVALID: &str =
    "The bot token looks wrong. Copy it from @BotFather, for example 123456789:AAH...";

// ---------------------------------------------------------------------------
// Waktu perusahaan
// ---------------------------------------------------------------------------

fn zone_label(timezone: &str) -> &'static str {
    match timezone_offset_hours(timezone) {
        8 => "WITA",
        9 => "WIT",
        _ => "WIB",
    }
}

/// Padanan `formatCompanyTime`.
pub fn format_company_time(stored: &str, timezone: &str) -> String {
    let Some(epoch) = parse_stored_timestamp(stored) else {
        return stored.to_owned();
    };
    let local = utc_timestamp(epoch + timezone_offset_hours(timezone) * 3600);
    format!("{} {}", &local[..16], zone_label(timezone))
}

/// Padanan `companyClock`: tanggal `YYYY-MM-DD` dan jam perusahaan.
pub fn company_clock(epoch_seconds: i64, timezone: &str) -> (String, i64) {
    let local = utc_timestamp(epoch_seconds + timezone_offset_hours(timezone) * 3600);
    (local[..10].to_owned(), local[11..13].parse().unwrap_or(0))
}

fn shift_date(date: &str, days: i64) -> Option<String> {
    let midnight = parse_stored_timestamp(&format!("{date} 00:00:00"))?;
    Some(utc_timestamp(midnight + days * 86_400)[..10].to_owned())
}

/// Padanan `coldDigestWindow`.
pub fn cold_digest_window(
    today: &str,
    last_digest_date: Option<&str>,
    warm_max_days: i64,
    timezone: &str,
) -> Option<(String, String)> {
    let earliest = shift_date(today, 1 - COLD_DIGEST_MAX_CATCH_UP_DAYS)?;
    let after_last = match last_digest_date {
        Some(date) => shift_date(date, 1)?,
        None => today.to_owned(),
    };
    let first_day = if after_last > earliest {
        after_last
    } else {
        earliest
    };
    if first_day.as_str() > today {
        return None;
    }
    let from = company_day_bounds_utc(&shift_date(&first_day, -warm_max_days - 1)?, timezone)?;
    let to = company_day_bounds_utc(&shift_date(today, -warm_max_days)?, timezone)?;
    Some((from.0, to.0))
}

// ---------------------------------------------------------------------------
// Teks pesan
// ---------------------------------------------------------------------------

fn field(payload: &Value, key: &str) -> String {
    match payload.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn or_dash(value: String) -> String {
    if value.trim().is_empty() {
        "-".to_owned()
    } else {
        value
    }
}

/// Padanan `renderNotification`.
pub fn render_notification(
    event_type: &str,
    payload: &Value,
    occurred_at: &str,
    timezone: &str,
) -> String {
    let when = format_company_time(occurred_at, timezone);
    let client = format!(
        "{} ({})",
        field(payload, "client_name"),
        field(payload, "client_code")
    );
    let sample = format!("{} for {client}", field(payload, "brand_name"));
    match event_type {
        "LEAD_NEW" => [
            format!("New lead: {client}"),
            format!(
                "Channel: {}, category: {}",
                or_dash(field(payload, "channel")),
                or_dash(field(payload, "category"))
            ),
            format!("PIC: {}", or_dash(field(payload, "pic"))),
            format!("Registered {when}"),
        ]
        .join("\n"),
        "SAMPLE_RND_REVIEW" => [
            format!("Sample request waiting for RnD review: {sample}"),
            format!("Deadline: {}", or_dash(field(payload, "deadline_at"))),
            format!("Submitted {when}"),
        ]
        .join("\n"),
        "SAMPLE_WAITING_PAYMENT" => [
            format!("Sample fee payment awaited: {sample}"),
            format!("Since {when}"),
        ]
        .join("\n"),
        "SAMPLE_PENDING_FEE" => [
            format!(
                "Revision {} is over the free quota and needs a fee decision: {sample}",
                field(payload, "revision_index")
            ),
            format!("Since {when}"),
        ]
        .join("\n"),
        "COLD_DIGEST" => {
            let leads = payload
                .get("leads")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut lines = vec![format!(
                "Leads that went Cold ({}): {}",
                field(payload, "date"),
                leads.len()
            )];
            lines.extend(leads.iter().map(|lead| {
                format!(
                    "- {} ({}), PIC {}",
                    field(lead, "client_name"),
                    field(lead, "client_code"),
                    or_dash(field(lead, "pic"))
                )
            }));
            lines.join("\n")
        }
        other => other.to_owned(),
    }
}

/// Padanan `testMessage`.
pub fn test_message(division: &str) -> String {
    format!("Company OS test message for the {division} group. Notifications are working.")
}

// ---------------------------------------------------------------------------
// SQL — WAJIB identik dengan `notification.ts` (dites per karakter di sana).
// ---------------------------------------------------------------------------

pub const NOTIFY_LEAD_NEW_SQL: &str = "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'lead-new:' || c.id, 'LEAD_NEW', 'CS', json_object('client_id', c.id, 'client_code', c.client_code, 'client_name', c.name, 'channel', COALESCE(ch.label, ''), 'category', COALESCE(cat.label, ''), 'pic', COALESCE(o.nama_operator, '')), c.created_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = 'telegram_chat_id_cs'), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_option ch ON ch.id = l.channel_option_id LEFT JOIN master_option cat ON cat.id = l.product_category_option_id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.id = ?1 LIMIT 1 ON CONFLICT(id) DO NOTHING;";

pub const NOTIFY_SAMPLE_STATUS_SQL: &str = "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) SELECT 'sample:' || ?1, CASE s.status WHEN 'RND_REVIEW' THEN 'SAMPLE_RND_REVIEW' WHEN 'WAITING_SAMPLE_PAYMENT' THEN 'SAMPLE_WAITING_PAYMENT' ELSE 'SAMPLE_PENDING_FEE' END, CASE s.status WHEN 'RND_REVIEW' THEN 'RND' ELSE 'FINANCE' END, json_object('sample_id', s.id, 'client_code', COALESCE(c.client_code, ''), 'client_name', COALESCE(c.name, ''), 'brand_name', s.brand_name, 'revision_index', s.revision_index, 'deadline_at', s.deadline_at), s.status_changed_at, CASE WHEN EXISTS (SELECT 1 FROM telegram_config t WHERE t.id = 'default' AND t.is_active = 1 AND TRIM(COALESCE(t.bot_token, '')) <> '') AND TRIM(COALESCE((SELECT g.value FROM setting_gex_system g WHERE g.key = CASE s.status WHEN 'RND_REVIEW' THEN 'telegram_chat_id_rnd' ELSE 'telegram_chat_id_finance' END), '')) <> '' THEN 'PENDING' ELSE 'SKIPPED' END, 0, datetime('now'), datetime('now') FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?2 AND s.status IN ('RND_REVIEW', 'WAITING_SAMPLE_PAYMENT', 'PENDING_FEE_ASSESSMENT') LIMIT 1 ON CONFLICT(id) DO NOTHING;";

pub const COLD_DIGEST_STATE_SQL: &str = "SELECT (SELECT COUNT(*) FROM notification_outbox WHERE id = ?1) AS done, COALESCE((SELECT MAX(id) FROM notification_outbox WHERE id LIKE 'cold-digest:%'), '') AS last_id;";

pub const COLD_DIGEST_LEADS_SQL: &str = "SELECT c.client_code, c.name AS client_name, COALESCE(o.nama_operator, '') AS pic FROM clients c JOIN leads l ON l.client_id = c.id LEFT JOIN master_operator o ON o.id = l.pic_cs_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at >= ?1 AND l.last_client_response_at < ?2 ORDER BY l.last_client_response_at, c.client_code LIMIT 50;";

pub const COLD_DIGEST_INSERT_SQL: &str = "INSERT INTO notification_outbox (id, event_type, target_division, payload_json, occurred_at, status, attempts, next_attempt_at, created_at) VALUES (?1, 'COLD_DIGEST', 'CS', ?2, datetime('now'), ?3, 0, datetime('now'), datetime('now')) ON CONFLICT(id) DO NOTHING;";

pub const NOTIFICATION_DUE_SQL: &str = "SELECT id, event_type, target_division, payload_json, occurred_at, attempts FROM notification_outbox WHERE status = 'PENDING' AND next_attempt_at <= datetime('now') AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes')) ORDER BY created_at, rowid LIMIT 10;";

pub const NOTIFICATION_CLAIM_SQL: &str = "UPDATE notification_outbox SET claimed_at = datetime('now'), attempts = attempts + 1 WHERE id = ?1 AND status = 'PENDING' AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes'));";

pub const NOTIFICATION_SENT_SQL: &str = "UPDATE notification_outbox SET status = 'SENT', sent_at = datetime('now'), claimed_at = NULL, last_error = '' WHERE id = ?1;";

pub const NOTIFICATION_SKIP_SQL: &str =
    "UPDATE notification_outbox SET status = 'SKIPPED', claimed_at = NULL WHERE id = ?1;";

pub const NOTIFICATION_FAILED_SQL: &str = "UPDATE notification_outbox SET status = CASE WHEN ?3 IS NULL THEN 'FAILED' ELSE status END, claimed_at = NULL, last_error = ?2, next_attempt_at = CASE WHEN ?3 IS NULL THEN next_attempt_at ELSE datetime('now', '+' || ?3 || ' minutes') END WHERE id = ?1;";

pub const NOTIFICATION_RETRY_FAILED_SQL: &str = "UPDATE notification_outbox SET status = 'PENDING', attempts = 0, claimed_at = NULL, next_attempt_at = datetime('now') WHERE status = 'FAILED';";

pub const NOTIFICATION_FAILED_LIST_SQL: &str = "SELECT id, event_type, target_division, occurred_at, attempts, last_error FROM notification_outbox WHERE status = 'FAILED' ORDER BY created_at DESC, rowid DESC LIMIT 50;";

pub const NOTIFICATION_PENDING_COUNT_SQL: &str =
    "SELECT COUNT(*) AS total FROM notification_outbox WHERE status = 'PENDING';";

pub const NOTIFICATION_BELL_LIST_SQL: &str = "SELECT id, event_type, target_division, payload_json, occurred_at, created_at FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) ORDER BY created_at DESC, rowid DESC LIMIT 30;";

pub const NOTIFICATION_UNREAD_COUNT_SQL: &str = "SELECT COUNT(*) AS total FROM notification_outbox WHERE ((?1 = 1 AND target_division = 'CS') OR (?2 = 1 AND target_division = 'RND') OR (?3 = 1 AND target_division = 'FINANCE')) AND NOT (event_type = 'COLD_DIGEST' AND json_array_length(payload_json, '$.leads') = 0) AND created_at > COALESCE((SELECT seen_at FROM notification_seen WHERE operator_id = ?4), '');";

pub const NOTIFICATION_MARK_SEEN_SQL: &str = "INSERT INTO notification_seen (operator_id, seen_at) VALUES (?1, datetime('now')) ON CONFLICT(operator_id) DO UPDATE SET seen_at = excluded.seen_at;";

pub const NOTIFICATION_CONTEXT_SQL: &str = "SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now_epoch, COALESCE((SELECT timezone FROM company_profile WHERE id = 'default_company'), '') AS timezone, COALESCE((SELECT is_active FROM telegram_config WHERE id = 'default'), 0) AS is_active, COALESCE((SELECT bot_token FROM telegram_config WHERE id = 'default'), '') AS bot_token, COALESCE((SELECT updated_at FROM telegram_config WHERE id = 'default'), '') AS updated_at, COALESCE((SELECT updated_by FROM telegram_config WHERE id = 'default'), '') AS updated_by;";

pub const NOTIFICATION_SETTINGS_SQL: &str = "SELECT key, value FROM setting_gex_system WHERE key IN ('lead_hot_max_days', 'lead_warm_max_days', 'telegram_chat_id_cs', 'telegram_chat_id_rnd', 'telegram_chat_id_finance');";

/// ?1 = token baru (kosong = pertahankan yang lama), ?2 = aktif, ?3 = pelaku.
pub const TELEGRAM_CONFIG_SAVE_SQL: &str = "INSERT INTO telegram_config (id, bot_token, is_active, updated_at, updated_by) VALUES ('default', ?1, ?2, datetime('now'), ?3) ON CONFLICT(id) DO UPDATE SET bot_token = CASE WHEN excluded.bot_token = '' THEN telegram_config.bot_token ELSE excluded.bot_token END, is_active = excluded.is_active, updated_at = excluded.updated_at, updated_by = excluded.updated_by;";

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

struct Context {
    now_epoch: i64,
    timezone: String,
    is_active: bool,
    bot_token: String,
    updated_at: String,
    updated_by: String,
    settings: BusinessSettings,
}

fn as_text(row: &HashMap<String, Value>, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn as_int(row: &HashMap<String, Value>, key: &str) -> i64 {
    row.get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or_default()
}

async fn load_context(turso: &TursoClient) -> Result<Context, CommandError> {
    turso.ensure_schema_current().await?;
    // Satu round-trip: pengirim berjalan di setiap siklus sync.
    let results = turso
        .execute_pipeline(vec![
            Statement::new(NOTIFICATION_CONTEXT_SQL, vec![]),
            Statement::new(NOTIFICATION_SETTINGS_SQL, vec![]),
        ])
        .await?;
    let row = results
        .first()
        .and_then(|result| result.to_objects().into_iter().next())
        .unwrap_or_default();
    let values: HashMap<String, String> = results
        .get(1)
        .map(|result| result.to_objects())
        .unwrap_or_default()
        .iter()
        .map(|setting| (as_text(setting, "key"), as_text(setting, "value")))
        .collect();
    let timezone = as_text(&row, "timezone");
    Ok(Context {
        now_epoch: as_int(&row, "now_epoch"),
        timezone: if timezone.trim().is_empty() {
            "Asia/Jakarta".to_owned()
        } else {
            timezone
        },
        is_active: as_int(&row, "is_active") == 1,
        bot_token: as_text(&row, "bot_token").trim().to_owned(),
        updated_at: as_text(&row, "updated_at"),
        updated_by: as_text(&row, "updated_by"),
        settings: samples::read_business_settings(&values),
    })
}

fn chat_id<'a>(settings: &'a BusinessSettings, division: &str) -> &'a str {
    match division {
        "CS" => &settings.telegram_chat_id_cs,
        "RND" => &settings.telegram_chat_id_rnd,
        "FINANCE" => &settings.telegram_chat_id_finance,
        _ => "",
    }
}

/// Kirim satu pesan teks polos. `Err` membawa penjelasan Telegram apa adanya
/// (E-09: ditampilkan di Pengaturan, hanya untuk pemegang `settings.manage`).
async fn send_telegram(http: &Client, token: &str, chat: &str, text: &str) -> Result<(), String> {
    let response = http
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .timeout(std::time::Duration::from_secs(15))
        .json(&json!({ "chat_id": chat, "text": text, "disable_web_page_preview": true }))
        .send()
        .await
        // Pesan reqwest bisa memuat URL lengkap, termasuk token di path-nya.
        .map_err(|error| format!("Request to Telegram failed: {}", error.without_url()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    let description = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or(body);
    Err(format!(
        "HTTP {}: {}",
        status.as_u16(),
        description.chars().take(300).collect::<String>()
    ))
}

async fn ensure_cold_digest(
    turso: &TursoClient,
    context: &Context,
    ready: bool,
) -> Result<(), CommandError> {
    let (today, hour) = company_clock(context.now_epoch, &context.timezone);
    if hour < COLD_DIGEST_HOUR {
        return Ok(());
    }
    let id = format!("cold-digest:{today}");
    let state = turso
        .query_one(COLD_DIGEST_STATE_SQL, vec![json!(id)])
        .await?
        .to_objects()
        .into_iter()
        .next()
        .unwrap_or_default();
    if as_int(&state, "done") > 0 {
        return Ok(());
    }
    let last_id = as_text(&state, "last_id");
    let Some((from, to)) = cold_digest_window(
        &today,
        last_id.strip_prefix("cold-digest:"),
        context.settings.lead_warm_max_days,
        &context.timezone,
    ) else {
        return Ok(());
    };
    let leads: Vec<Value> = turso
        .query_one(COLD_DIGEST_LEADS_SQL, vec![json!(from), json!(to)])
        .await?
        .to_objects()
        .iter()
        .map(|lead| {
            json!({
                "client_code": as_text(lead, "client_code"),
                "client_name": as_text(lead, "client_name"),
                "pic": as_text(lead, "pic"),
            })
        })
        .collect();
    let status = if ready && !leads.is_empty() && !context.settings.telegram_chat_id_cs.is_empty() {
        "PENDING"
    } else {
        "SKIPPED"
    };
    turso
        .query_one(
            COLD_DIGEST_INSERT_SQL,
            vec![
                json!(id),
                json!(json!({ "date": today, "leads": leads }).to_string()),
                json!(status),
            ],
        )
        .await?;
    Ok(())
}

/// Satu putaran pengirim: buat ringkasan Cold hari ini bila waktunya, lalu
/// klaim dan kirim baris yang jatuh tempo. Dipanggil di akhir siklus sync
/// (hasilnya diabaikan pemanggil, aturan 9) dan sesudah "Retry failed".
pub async fn dispatch(turso: &TursoClient, http: &Client) -> Result<(), CommandError> {
    let context = load_context(turso).await?;
    let ready = context.is_active && !context.bot_token.is_empty();
    ensure_cold_digest(turso, &context, ready).await?;
    if !ready {
        return Ok(());
    }
    let due = turso
        .query_one(NOTIFICATION_DUE_SQL, vec![])
        .await?
        .to_objects();
    for row in due {
        let id = as_text(&row, "id");
        let claimed = turso
            .query_one(NOTIFICATION_CLAIM_SQL, vec![json!(id)])
            .await?;
        if claimed.rows_affected != 1 {
            continue;
        }
        let chat = chat_id(&context.settings, &as_text(&row, "target_division"));
        if chat.is_empty() {
            turso
                .query_one(NOTIFICATION_SKIP_SQL, vec![json!(id)])
                .await?;
            continue;
        }
        let payload = serde_json::from_str::<Value>(&as_text(&row, "payload_json"))
            .unwrap_or_else(|_| json!({}));
        let message = render_notification(
            &as_text(&row, "event_type"),
            &payload,
            &as_text(&row, "occurred_at"),
            &context.timezone,
        );
        match send_telegram(http, &context.bot_token, chat, &message).await {
            Ok(()) => {
                turso
                    .query_one(NOTIFICATION_SENT_SQL, vec![json!(id)])
                    .await?;
            }
            Err(detail) => {
                let delay = retry_delay_minutes(as_int(&row, "attempts") + 1);
                turso
                    .query_one(
                        NOTIFICATION_FAILED_SQL,
                        vec![json!(id), json!(detail), json!(delay)],
                    )
                    .await?;
            }
        }
    }
    Ok(())
}

/// Pengaturan › Notifikasi: tanpa token, ditambah antrean dan daftar gagal.
pub async fn telegram_settings(turso: &TursoClient) -> Result<Value, CommandError> {
    let context = load_context(turso).await?;
    let pending = turso
        .query_one(NOTIFICATION_PENDING_COUNT_SQL, vec![])
        .await?
        .to_objects();
    let failed: Vec<Value> = turso
        .query_one(NOTIFICATION_FAILED_LIST_SQL, vec![])
        .await?
        .to_objects()
        .iter()
        .map(|row| {
            json!({
                "id": as_text(row, "id"),
                "event_type": as_text(row, "event_type"),
                "target_division": as_text(row, "target_division"),
                "occurred_at": as_text(row, "occurred_at"),
                "attempts": as_int(row, "attempts"),
                "last_error": as_text(row, "last_error"),
            })
        })
        .collect();
    Ok(json!({
        "config": {
            "is_active": context.is_active,
            "has_bot_token": !context.bot_token.is_empty(),
            "updated_at": context.updated_at,
            "updated_by": context.updated_by,
        },
        "pending": pending.first().map(|row| as_int(row, "total")).unwrap_or_default(),
        "failed": failed,
    }))
}

/// Padanan `saveTelegramConfig`; pesan identik.
pub async fn save_telegram_config(
    turso: &TursoClient,
    draft: &Value,
    actor: &str,
) -> Result<Value, CommandError> {
    let token = draft
        .get("bot_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let is_active = draft.get("is_active").and_then(Value::as_bool) == Some(true);
    if !token.is_empty() && !is_telegram_bot_token(&token) {
        return Err(CommandError::new(
            "TELEGRAM_CONFIG_INVALID",
            TELEGRAM_TOKEN_INVALID,
        ));
    }
    let context = load_context(turso).await?;
    if is_active && token.is_empty() && context.bot_token.is_empty() {
        return Err(CommandError::new(
            "TELEGRAM_CONFIG_INVALID",
            TELEGRAM_TOKEN_REQUIRED,
        ));
    }
    turso
        .query_one(
            TELEGRAM_CONFIG_SAVE_SQL,
            vec![json!(token), json!(i64::from(is_active)), json!(actor)],
        )
        .await?;
    telegram_settings(turso).await
}

/// Uji kirim ke grup satu divisi, dengan token tersimpan (boleh sebelum bot
/// dinyalakan). Balasannya memuat penjelasan Telegram apa adanya.
pub async fn send_test(
    turso: &TursoClient,
    http: &Client,
    division: &str,
) -> Result<Value, CommandError> {
    if !NOTIFICATION_DIVISIONS.contains(&division) {
        return Err(CommandError::new(
            "TELEGRAM_CONFIG_INVALID",
            "Choose a division.",
        ));
    }
    let context = load_context(turso).await?;
    if context.bot_token.is_empty() {
        return Err(CommandError::new(
            "TELEGRAM_CONFIG_INVALID",
            TELEGRAM_TOKEN_REQUIRED,
        ));
    }
    let chat = chat_id(&context.settings, division);
    if chat.is_empty() {
        return Err(CommandError::new(
            "TELEGRAM_CONFIG_INVALID",
            format!("Set the {division} group chat ID in Business settings first."),
        ));
    }
    Ok(
        match send_telegram(http, &context.bot_token, chat, &test_message(division)).await {
            Ok(()) => json!({ "delivered": true, "detail": "" }),
            Err(detail) => json!({ "delivered": false, "detail": detail }),
        },
    )
}

pub async fn retry_failed(turso: &TursoClient) -> Result<u64, CommandError> {
    turso.ensure_schema_current().await?;
    Ok(turso
        .query_one(NOTIFICATION_RETRY_FAILED_SQL, vec![])
        .await?
        .rows_affected)
}

/// Lonceng: 30 kejadian terakhir dari divisi yang boleh dilihat, plus jumlah
/// yang belum dibaca. `allowed` = urutan CS, RnD, Finance.
pub async fn bell(
    turso: &TursoClient,
    allowed: [bool; 3],
    operator_id: i64,
) -> Result<Value, CommandError> {
    let context = load_context(turso).await?;
    let flags: Vec<Value> = allowed.iter().map(|flag| json!(i64::from(*flag))).collect();
    let mut unread_args = flags.clone();
    unread_args.push(json!(operator_id));
    let unread = turso
        .query_one(NOTIFICATION_UNREAD_COUNT_SQL, unread_args)
        .await?
        .to_objects();
    let items: Vec<Value> = turso
        .query_one(NOTIFICATION_BELL_LIST_SQL, flags)
        .await?
        .to_objects()
        .iter()
        .map(|row| {
            let payload = serde_json::from_str::<Value>(&as_text(row, "payload_json")).unwrap_or_else(|_| json!({}));
            let event_type = as_text(row, "event_type");
            json!({
                "id": as_text(row, "id"),
                "event_type": event_type,
                "target_division": as_text(row, "target_division"),
                "text": render_notification(&event_type, &payload, &as_text(row, "occurred_at"), &context.timezone),
                "client_id": field(&payload, "client_id"),
                "sample_id": field(&payload, "sample_id"),
                "created_at": as_text(row, "created_at"),
            })
        })
        .collect();
    Ok(json!({
        "unread": unread.first().map(|row| as_int(row, "total")).unwrap_or_default(),
        "items": items,
    }))
}

pub async fn mark_seen(turso: &TursoClient, operator_id: i64) -> Result<(), CommandError> {
    turso.ensure_schema_current().await?;
    turso
        .query_one(NOTIFICATION_MARK_SEEN_SQL, vec![json!(operator_id)])
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/notification.test.ts`.

    #[test]
    fn jeda_coba_ulang_berhenti_setelah_lima_kali() {
        let delays: Vec<Option<i64>> = (1..=6).map(retry_delay_minutes).collect();
        assert_eq!(
            delays,
            vec![Some(1), Some(5), Some(15), Some(60), None, None]
        );
    }

    #[test]
    fn token_bot_dikenali() {
        assert!(is_telegram_bot_token(
            "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
        ));
        assert!(is_telegram_bot_token(
            " 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw "
        ));
        assert!(!is_telegram_bot_token("123456789:short"));
        assert!(!is_telegram_bot_token(
            "abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
        ));
        assert!(!is_telegram_bot_token("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
    }

    #[test]
    fn waktu_perusahaan() {
        assert_eq!(
            format_company_time("2026-10-03 07:05:00", "Asia/Jakarta"),
            "2026-10-03 14:05 WIB"
        );
        assert_eq!(
            format_company_time("2026-10-03T07:05:00Z", "Asia/Makassar"),
            "2026-10-03 15:05 WITA"
        );
        assert_eq!(
            format_company_time("2026-10-03 20:00:00", "Asia/Jayapura"),
            "2026-10-04 05:00 WIT"
        );
        assert_eq!(format_company_time("rusak", "Asia/Jakarta"), "rusak");
        // 2026-10-03 00:30 UTC = 07:30 WIB.
        assert_eq!(
            company_clock(1_790_987_400, "Asia/Jakarta"),
            ("2026-10-03".to_owned(), 7)
        );
    }

    #[test]
    fn jendela_ringkasan_cold() {
        let window = |last: Option<&str>| cold_digest_window("2026-10-10", last, 7, "Asia/Jakarta");
        // Pertama kali: hanya yang menjadi Cold hari ini (respons 2026-10-02 WIB).
        assert_eq!(
            window(None),
            Some(("2026-10-01 17:00:00".into(), "2026-10-02 17:00:00".into()))
        );
        // Ringkasan terakhir kemarin: sama dengan hari ini saja.
        assert_eq!(window(Some("2026-10-09")), window(None));
        // Terlewat dua hari: respons 2026-09-30 sampai 2026-10-02.
        assert_eq!(
            window(Some("2026-10-07")),
            Some(("2026-09-29 17:00:00".into(), "2026-10-02 17:00:00".into()))
        );
        // Terlewat jauh: dikejar paling banyak 7 hari (respons mulai 2026-09-26).
        assert_eq!(
            window(Some("2026-09-01")),
            Some(("2026-09-25 17:00:00".into(), "2026-10-02 17:00:00".into()))
        );
        // Sudah dibuat hari ini.
        assert_eq!(window(Some("2026-10-10")), None);
    }

    #[test]
    fn teks_pesan() {
        let lead = json!({ "client_name": "Aura Beauty", "client_code": "KLN-20261003-WB01", "channel": "Instagram", "category": "", "pic": "Rina" });
        assert_eq!(
            render_notification("LEAD_NEW", &lead, "2026-10-03 07:05:00", "Asia/Jakarta"),
            "New lead: Aura Beauty (KLN-20261003-WB01)\nChannel: Instagram, category: -\nPIC: Rina\nRegistered 2026-10-03 14:05 WIB"
        );
        let sample = json!({ "client_name": "Aura Beauty", "client_code": "KLN-20261003-WB01", "brand_name": "Aura Glow", "revision_index": 2, "deadline_at": "2026-10-31" });
        assert_eq!(
            render_notification("SAMPLE_RND_REVIEW", &sample, "2026-10-03 07:05:00", "Asia/Jakarta"),
            "Sample request waiting for RnD review: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nDeadline: 2026-10-31\nSubmitted 2026-10-03 14:05 WIB"
        );
        assert_eq!(
            render_notification("SAMPLE_WAITING_PAYMENT", &sample, "2026-10-03 07:05:00", "Asia/Jakarta"),
            "Sample fee payment awaited: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nSince 2026-10-03 14:05 WIB"
        );
        assert_eq!(
            render_notification("SAMPLE_PENDING_FEE", &sample, "2026-10-03 07:05:00", "Asia/Jakarta"),
            "Revision 2 is over the free quota and needs a fee decision: Aura Glow for Aura Beauty (KLN-20261003-WB01)\nSince 2026-10-03 14:05 WIB"
        );
        let digest = json!({ "date": "2026-10-10", "leads": [
            { "client_name": "Aura", "client_code": "KLN-1", "pic": "Rina" },
            { "client_name": "Bina", "client_code": "KLN-2", "pic": "" },
        ] });
        assert_eq!(
            render_notification(
                "COLD_DIGEST",
                &digest,
                "2026-10-10 01:00:00",
                "Asia/Jakarta"
            ),
            "Leads that went Cold (2026-10-10): 2\n- Aura (KLN-1), PIC Rina\n- Bina (KLN-2), PIC -"
        );
        assert_eq!(
            test_message("RND"),
            "Company OS test message for the RND group. Notifications are working."
        );
    }
}
