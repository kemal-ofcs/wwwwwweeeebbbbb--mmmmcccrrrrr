//! Aturan domain klien yang WAJIB identik dengan `src/lib/validations/client.ts`.
//!
//! Fungsi di sini murni (tanpa I/O) supaya bisa diuji dengan vektor yang sama
//! seperti `client.test.ts`: kode klien buatan Web dan perangkat harus
//! mengikuti aturan yang persis sama, dan nomor WhatsApp yang sama harus
//! menghasilkan bentuk normal yang sama supaya pemeriksaan duplikat tidak bisa
//! diakali. Ikut `filesToSync` di `mobile/scripts/sync-rust-modules.ts`.

pub const DEFAULT_CLIENT_CODE_PREFIX: &str = "KLN";
pub const DEFAULT_CLIENT_CODE_WEB_TAG: &str = "WB";
pub const CLIENT_CODE_PREFIX_SETTING: &str = "client_code_prefix";
pub const CLIENT_CODE_WEB_TAG_SETTING: &str = "client_code_web_tag";

pub const CLIENT_LIFECYCLE_STATUSES: &[&str] = &["LEAD", "FIRST_ORDER_ACTIVE", "EXISTING_CLIENT"];
pub const MASTER_OPTION_KINDS: &[&str] = &[
    "LEAD_CHANNEL",
    "PRODUCT_CATEGORY",
    // Tiket sampel (PRD FR-06.1, keputusan M): nilainya milik perusahaan.
    "SAMPLE_KIND",
    "FORMULATION_TYPE",
    "REGISTRATION_CATEGORY",
];

pub const CLIENT_NAME_MIN: usize = 2;
pub const CLIENT_NAME_MAX: usize = 120;
pub const CLIENT_TEXT_MAX: usize = 300;
pub const CLIENT_NOTES_MAX: usize = 2000;
pub const OPTION_LABEL_MAX: usize = 80;

const BASE36: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/// Dua digit basis-36 tanpa nol = 1..1295 kode per tag per tanggal.
pub const MAX_CLIENT_SEQUENCE: u32 = 36 * 36 - 1;

/// Bentuk normal nomor WhatsApp: `62` + digit, 10-15 digit total. Padanan
/// `normalizeWhatsapp` di TS.
pub fn normalize_whatsapp(raw: &str) -> Option<String> {
    let mut value: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '.' | '(' | ')'))
        .collect();
    if let Some(rest) = value.strip_prefix('+') {
        value = rest.to_owned();
    }
    if let Some(rest) = value.strip_prefix('0') {
        value = format!("62{rest}");
    }
    if !value.starts_with("62") || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if value.len() < 10 || value.len() > 15 {
        return None;
    }
    Some(value)
}

pub fn normalize_code_prefix(raw: &str) -> Option<String> {
    let value = raw.trim().to_uppercase();
    let valid = (2..=5).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_uppercase());
    valid.then_some(value)
}

pub fn normalize_device_tag(raw: &str) -> Option<String> {
    let value = raw.trim().to_uppercase();
    let valid = value.len() == 2
        && value
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    valid.then_some(value)
}

pub fn normalize_option_code(raw: &str) -> Option<String> {
    let value = raw.trim().to_uppercase();
    let valid = (1..=20).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    valid.then_some(value)
}

fn base36_pair(value: u32) -> String {
    let high = BASE36[(value / 36) as usize] as char;
    let low = BASE36[(value % 36) as usize] as char;
    format!("{high}{low}")
}

/// `KLN-20260925-A101`. `None` bila urutan di luar 1..1295.
pub fn format_client_code(prefix: &str, date_stamp: &str, tag: &str, sequence: u32) -> Option<String> {
    if sequence < 1 || sequence > MAX_CLIENT_SEQUENCE {
        return None;
    }
    Some(format!("{prefix}-{date_stamp}-{tag}{}", base36_pair(sequence)))
}

/// Urutan berikutnya untuk satu tag pada satu tanggal. Padanan
/// `nextClientSequence` di TS: awalan apa pun ikut dihitung.
pub fn next_client_sequence<'a>(
    codes: impl IntoIterator<Item = &'a str>,
    date_stamp: &str,
    tag: &str,
) -> Option<u32> {
    let marker = format!("-{date_stamp}-{tag}");
    let mut highest = 0u32;
    for code in codes {
        let Some(at) = code.rfind(&marker) else {
            continue;
        };
        if code.len() != at + marker.len() + 2 {
            continue;
        }
        let pair = &code.as_bytes()[code.len() - 2..];
        let high = BASE36.iter().position(|b| *b == pair[0]);
        let low = BASE36.iter().position(|b| *b == pair[1]);
        if let (Some(high), Some(low)) = (high, low) {
            highest = highest.max((high * 36 + low) as u32);
        }
    }
    (highest < MAX_CLIENT_SEQUENCE).then_some(highest + 1)
}

/// Selisih jam zona waktu Indonesia; zona lain dianggap WIB.
pub fn timezone_offset_hours(timezone: &str) -> i64 {
    match timezone.trim() {
        "Asia/Makassar" => 8,
        "Asia/Jayapura" => 9,
        _ => 7,
    }
}

/// Tanggal sipil (tahun, bulan, hari) dari jumlah hari sejak 1970-01-01.
/// Algoritma Howard Hinnant, sama dengan helper di `license.rs`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Tanggal perusahaan `YYYYMMDD` dari epoch detik UTC.
pub fn company_date_stamp(epoch_seconds: i64, timezone: &str) -> String {
    let shifted = epoch_seconds + timezone_offset_hours(timezone) * 3600;
    let (year, month, day) = civil_from_days(shifted.div_euclid(86_400));
    format!("{year:04}{month:02}{day:02}")
}

/// Stempel waktu UTC berbentuk sama dengan `datetime('now')` SQLite, supaya
/// baris buatan perangkat dan buatan Web terbaca `formatDateTime` dengan cara
/// yang sama.
pub fn utc_timestamp(epoch_seconds: i64) -> String {
    let (year, month, day) = civil_from_days(epoch_seconds.div_euclid(86_400));
    let seconds = epoch_seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// UUID v4 acak. Kunci utama dibuat di perangkat karena baris offline dari dua
/// perangkat tidak boleh bertabrakan (autoincrement tidak bisa dipakai).
pub fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Tag perangkat ke-`index` (1..1295) dalam urutan `01`..`ZZ`. Dipakai saat
/// cloud menerbitkan tag untuk perangkat baru.
pub fn device_tag_from_index(index: u32) -> Option<String> {
    (1..=MAX_CLIENT_SEQUENCE).contains(&index).then(|| base36_pair(index))
}

// ── Interaksi lead & segmentasi (PRD FR-05) ─────────────────────────────────
// Padanan TS ada di `src/lib/validations/client.ts`, diuji dengan vektor yang sama.

pub const LEAD_INTERACTION_DIRECTIONS: &[&str] = &["OUTBOUND", "INBOUND"];
pub const LEAD_INTERACTION_KINDS: &[&str] = &["WHATSAPP", "CALL", "VISIT", "MATERIAL", "OTHER"];
pub const INTERACTION_NOTES_MAX: usize = 1000;
pub const INTERACTION_MAX_AGE_SECONDS: i64 = 366 * 86_400;
pub const INTERACTION_FUTURE_TOLERANCE_SECONDS: i64 = 300;

/// Jumlah hari sejak 1970-01-01 untuk tanggal sipil. Kebalikan `civil_from_days`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Epoch detik dari `YYYY-MM-DD HH:MM:SS` (boleh `T` dan akhiran `Z`), dibaca
/// sebagai UTC. Padanan `parseStoredTimestamp`.
pub fn parse_stored_timestamp(value: &str) -> Option<i64> {
    let value = value.trim();
    let value = value.strip_suffix('Z').unwrap_or(value);
    let bytes = value.as_bytes();
    if bytes.len() != 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !(bytes[10] == b' ' || bytes[10] == b'T')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &value[range];
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

fn company_day_number(epoch_seconds: i64, timezone: &str) -> i64 {
    (epoch_seconds + timezone_offset_hours(timezone) * 3600).div_euclid(86_400)
}

/// Hari kalender perusahaan sejak respons terakhir; tidak pernah negatif.
pub fn days_since_response(last_response_at: &str, now_epoch_seconds: i64, timezone: &str) -> Option<i64> {
    let last = parse_stored_timestamp(last_response_at)?;
    Some((company_day_number(now_epoch_seconds, timezone) - company_day_number(last, timezone)).max(0))
}

/// Segmen hanya untuk klien `LEAD` (D-09). Batasnya dari setelan bisnis
/// (padanan `leadSegment`).
pub fn lead_segment(lifecycle_status: &str, days: Option<i64>, hot_max_days: i64, warm_max_days: i64) -> Option<&'static str> {
    if lifecycle_status != "LEAD" {
        return None;
    }
    let days = days?;
    Some(if days <= hot_max_days {
        "HOT"
    } else if days <= warm_max_days {
        "WARM"
    } else {
        "COLD"
    })
}

/// Waktu interaksi yang diminta atau sekarang bila kosong. Pesan penolakannya
/// identik dengan `resolveInteractionTime`.
pub fn resolve_interaction_time(requested: Option<&serde_json::Value>, now_epoch_seconds: i64) -> Result<i64, &'static str> {
    let Some(requested) = requested.filter(|value| !value.is_null()) else {
        return Ok(now_epoch_seconds);
    };
    let epoch = requested
        .as_i64()
        .filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
        .ok_or("The interaction time is not valid.")?;
    if epoch > now_epoch_seconds + INTERACTION_FUTURE_TOLERANCE_SECONDS {
        return Err("The interaction time cannot be in the future.");
    }
    if epoch < now_epoch_seconds - INTERACTION_MAX_AGE_SECONDS {
        return Err("The interaction time cannot be more than a year ago.");
    }
    Ok(epoch)
}

/// Ringkasan lead setelah satu interaksi, dijalankan SEBELUM baris interaksinya
/// disisipkan. Aman diulang dan tidak bergantung urutan: tanggal hanya maju
/// ("ambil yang terbaru"), dan Jumlah FU hanya bertambah bila interaksi itu
/// belum pernah tercatat. Dipakai perangkat, handler push cloud, dan jalur Web
/// (`LEAD_SUMMARY_UPDATE_SQL` di `src/lib/server/leads.ts`, WAJIB identik).
/// Parameter: ?1 arah, ?2 waktu interaksi, ?3 id lead, ?4 id interaksi.
pub const LEAD_SUMMARY_UPDATE_SQL: &str = "UPDATE leads SET last_followup_at = CASE WHEN ?1 = 'OUTBOUND' AND ?2 > last_followup_at THEN ?2 ELSE last_followup_at END, last_client_response_at = CASE WHEN ?1 = 'INBOUND' AND ?2 > last_client_response_at THEN ?2 ELSE last_client_response_at END, total_followups = total_followups + CASE WHEN ?1 = 'OUTBOUND' THEN 1 ELSE 0 END WHERE id = ?3 AND NOT EXISTS (SELECT 1 FROM lead_interactions WHERE id = ?4);";

/// Sisipkan satu interaksi; kiriman ulang diabaikan. Parameter: id, lead_id,
/// operator_id, direction, kind, notes, occurred_at, created_at.
pub const LEAD_INTERACTION_INSERT_SQL: &str = "INSERT INTO lead_interactions (id, lead_id, operator_id, direction, kind, notes, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/// Sisipkan satu baris log audit; kiriman ulang diabaikan dan baris lama tidak
/// pernah ditimpa. Dipakai perangkat, handler push, dan Web
/// (`DOMAIN_AUDIT_INSERT_SQL` di `src/lib/server/audit.ts`, WAJIB identik).
/// Parameter: id, actor_operator_id, on_behalf_of_division, action,
/// entity_type, entity_id, summary_json, occurred_at.
pub const DOMAIN_AUDIT_INSERT_SQL: &str = "INSERT INTO domain_audit_log (id, actor_operator_id, on_behalf_of_division, action, entity_type, entity_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/// Daftar log audit, terbaru dulu, paling banyak 200 baris. SQL statis dengan
/// filter opsional, dipakai cloud, SQLite lokal, dan Web (`DOMAIN_AUDIT_LIST_SQL`
/// di `src/lib/server/audit.ts`, WAJIB identik). Parameter: ?1 jenis entitas
/// (`''` = semua), ?2 id pelaku (`0` = semua), ?3 batas awal UTC inklusif,
/// ?4 batas akhir UTC eksklusif (`''` = tanpa batas).
pub const DOMAIN_AUDIT_LIST_SQL: &str = "SELECT a.id, a.actor_operator_id, o.nama_operator AS actor_name, a.on_behalf_of_division, a.action, a.entity_type, a.entity_id, a.summary_json, a.occurred_at FROM domain_audit_log a LEFT JOIN master_operator o ON o.id = a.actor_operator_id WHERE (?1 = '' OR a.entity_type = ?1) AND (?2 = 0 OR a.actor_operator_id = ?2) AND (?3 = '' OR a.occurred_at >= ?3) AND (?4 = '' OR a.occurred_at < ?4) ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 200;";

/// Sesi tunggal (PRD FR-03). Konstanta di bawah dipakai cloud dari Rust dan
/// dari Web (`src/lib/server/sessions.ts`), WAJIB identik: satu database
/// dilayani keduanya, dan waktu di `app_session` bercampur bentuk ISO (Web)
/// dengan `datetime('now')` (perangkat), sehingga setiap perbandingan waktu
/// memakai `julianday()`, tidak pernah perbandingan teks.
///
/// Login online terakhir menang: cabut sesi lain milik operator ini.
/// Parameter: ?1 id operator.
pub const SESSION_SUPERSEDE_SQL: &str = "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = 'SUPERSEDED' WHERE operator_id = ?1 AND revoked_at IS NULL;";

/// Buang sesi kedaluwarsa dan sesi yang dicabut lebih dari 30 hari lalu.
/// Sesi yang baru dicabut SENGAJA disimpan: perangkat yang lama offline
/// membandingkan sesi yang lahir setelah kontak terakhirnya, termasuk yang
/// sudah logout, dan layar login Web membaca alasan pencabutannya.
pub const SESSION_PURGE_SQL: &str = "DELETE FROM app_session WHERE julianday(expires_at) <= julianday('now') OR (revoked_at IS NOT NULL AND julianday(revoked_at) < julianday('now') - 30);";

/// Sesi offline yang tersambung lagi tersusul bila cloud punya sesi operator
/// ini yang lahir SETELAH kontak online terakhir perangkat (PRD FR-03 butir 3),
/// termasuk yang sudah logout. Tanpa catatan kontak (perangkat dari versi
/// sebelum sesi tunggal) yang dihitung hanya sesi yang masih aktif.
/// Parameter: ?1 id operator, ?2 kontak terakhir atau NULL.
pub const OFFLINE_SESSION_SUPERSEDED_SQL: &str = "SELECT datetime('now') AS now, (SELECT COUNT(*) FROM app_session WHERE operator_id = ?1 AND ((?2 IS NULL AND revoked_at IS NULL) OR julianday(created_at) > julianday(?2))) AS total;";

/// Sesi aktif semua operator (layar Audit & Sesi), terakhir terlihat dulu.
pub const ACTIVE_SESSION_LIST_SQL: &str = "SELECT s.session_id, s.operator_id, o.nama_operator AS operator_name, s.client_kind, s.device_label, s.created_at, s.last_seen_at FROM app_session s LEFT JOIN master_operator o ON o.id = s.operator_id WHERE s.revoked_at IS NULL AND julianday(s.expires_at) > julianday('now') ORDER BY julianday(s.last_seen_at) DESC, s.rowid DESC LIMIT 500;";

/// Akhiri satu sesi. Parameter: ?1 id sesi, ?2 alasan tersimpan.
pub const SESSION_END_SQL: &str = "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = ?2 WHERE session_id = ?1 AND revoked_at IS NULL;";

/// Akhiri semua sesi seorang operator. Parameter: ?1 id operator, ?2 alasan.
pub const SESSION_END_OPERATOR_SQL: &str = "UPDATE app_session SET revoked_at = datetime('now'), revoked_reason = ?2 WHERE operator_id = ?1 AND revoked_at IS NULL;";

/// Alasan yang disimpan saat pemegang `sessions.manage` mengakhiri sesi.
/// Alasan tertulisnya masuk log audit, bukan ke baris sesi.
pub const SESSION_ENDED_BY_ADMIN: &str = "ENDED_BY_ADMIN";

/// Alasan pengakhiran wajib diisi, 3-300 karakter (PRD SCR-07).
pub fn session_end_reason(value: &str) -> Result<String, &'static str> {
    let reason = value.trim();
    let length = reason.chars().count();
    if !(3..=300).contains(&length) {
        return Err("Give a reason of 3-300 characters for ending the session.");
    }
    Ok(reason.to_owned())
}

/// Batas UTC satu hari kalender perusahaan (`YYYY-MM-DD`): awal hari itu dan
/// awal hari berikutnya, berbentuk `datetime('now')`. Padanan
/// `companyDayBoundsUtc` di TS.
pub fn company_day_bounds_utc(date: &str, timezone: &str) -> Option<(String, String)> {
    let start = parse_stored_timestamp(&format!("{} 00:00:00", date.trim()))?
        - timezone_offset_hours(timezone) * 3600;
    Some((utc_timestamp(start), utc_timestamp(start + 86_400)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar: `src/lib/validations/client.test.ts` memakai masukan dan
    // keluaran yang persis sama. Ubah keduanya bersamaan.

    #[test]
    fn normalisasi_whatsapp() {
        let cases: &[(&str, Option<&str>)] = &[
            ("0812-3456-7890", Some("6281234567890")),
            ("+62 812 3456 7890", Some("6281234567890")),
            ("62812.3456.789", Some("628123456789")),
            ("(0812) 345 678", Some("62812345678")),
            ("812345678", None),
            ("0812abc", None),
            ("08123", None),
            ("", None),
            ("+6281234567890123", None),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_whatsapp(input).as_deref(), *expected, "{input}");
        }
    }

    #[test]
    fn format_kode_klien() {
        assert_eq!(format_client_code("KLN", "20260925", "A1", 1).as_deref(), Some("KLN-20260925-A101"));
        assert_eq!(format_client_code("KLN", "20260925", "A1", 35).as_deref(), Some("KLN-20260925-A10Z"));
        assert_eq!(format_client_code("KLN", "20260925", "A1", 36).as_deref(), Some("KLN-20260925-A110"));
        assert_eq!(format_client_code("CUS", "20260925", "WB", 1295).as_deref(), Some("CUS-20260925-WBZZ"));
        assert_eq!(format_client_code("KLN", "20260925", "A1", 0), None);
        assert_eq!(format_client_code("KLN", "20260925", "A1", 1296), None);
    }

    #[test]
    fn urutan_berikutnya() {
        assert_eq!(next_client_sequence([], "20260925", "A1"), Some(1));
        let codes = [
            "KLN-20260925-A101",
            "KLN-20260925-A10Z",
            "CUS-20260925-A103",
            "KLN-20260924-A1ZZ",
            "KLN-20260925-B105",
            "KLN-20260925-A1??",
        ];
        assert_eq!(next_client_sequence(codes, "20260925", "A1"), Some(36));
        assert_eq!(next_client_sequence(["KLN-20260925-A1ZZ"], "20260925", "A1"), None);
    }

    #[test]
    fn tanggal_perusahaan() {
        let cases: &[(i64, &str, &str)] = &[
            (1790269200, "Asia/Jakarta", "20260925"),
            (1790269199, "Asia/Jakarta", "20260924"),
            (1790269199, "Asia/Makassar", "20260925"),
            (1790262000, "Asia/Makassar", "20260924"),
            (1790262000, "Asia/Jayapura", "20260925"),
            (1790269200, "Europe/London", "20260925"),
            (1798759800, "Asia/Jakarta", "20270101"),
        ];
        for (epoch, zone, expected) in cases {
            assert_eq!(company_date_stamp(*epoch, zone), *expected, "{epoch} {zone}");
        }
    }

    #[test]
    fn normalisasi_kode() {
        assert_eq!(normalize_code_prefix(" kln ").as_deref(), Some("KLN"));
        assert_eq!(normalize_code_prefix("K"), None);
        assert_eq!(normalize_code_prefix("KLNMKL"), None);
        assert_eq!(normalize_code_prefix("KL1"), None);
        assert_eq!(normalize_device_tag("wb").as_deref(), Some("WB"));
        assert_eq!(normalize_device_tag("A1").as_deref(), Some("A1"));
        assert_eq!(normalize_device_tag("A"), None);
        assert_eq!(normalize_device_tag("A-"), None);
        assert_eq!(normalize_option_code(" ig-ads ").as_deref(), Some("IG-ADS"));
        assert_eq!(normalize_option_code(""), None);
        assert_eq!(normalize_option_code("A B"), None);
    }

    #[test]
    fn stempel_waktu_uuid_dan_tag() {
        assert_eq!(utc_timestamp(1790269199), "2026-09-24 16:59:59");
        assert_eq!(utc_timestamp(1798759800), "2026-12-31 23:30:00");
        let id = new_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert_ne!(id, new_uuid());
        assert_eq!(device_tag_from_index(1).as_deref(), Some("01"));
        assert_eq!(device_tag_from_index(36).as_deref(), Some("10"));
        assert_eq!(device_tag_from_index(1295).as_deref(), Some("ZZ"));
        assert_eq!(device_tag_from_index(0), None);
    }

    #[test]
    fn stempel_tersimpan() {
        assert_eq!(parse_stored_timestamp("2026-09-24 17:00:00"), Some(1790269200));
        assert_eq!(parse_stored_timestamp("2026-09-24T17:00:00Z"), Some(1790269200));
        assert_eq!(parse_stored_timestamp(" 2026-12-31 23:30:00 "), Some(1798759800));
        assert_eq!(parse_stored_timestamp(""), None);
        assert_eq!(parse_stored_timestamp("2026-09-24"), None);
        assert_eq!(parse_stored_timestamp("2026-13-01 00:00:00"), None);
        assert_eq!(parse_stored_timestamp("2026-09-24 24:00:00"), None);
        assert_eq!(utc_timestamp(parse_stored_timestamp("2026-09-24 17:00:00").unwrap()), "2026-09-24 17:00:00");
    }

    #[test]
    fn segmen_lead() {
        // Sekarang = 2026-09-25 12:00 WIB.
        let now = 1790312400;
        let cases: &[(&str, &str, Option<i64>, Option<&str>)] = &[
            ("2026-09-24 17:00:00", "Asia/Jakarta", Some(0), Some("HOT")),
            ("2026-09-24 16:59:59", "Asia/Jakarta", Some(1), Some("HOT")),
            ("2026-09-22 05:00:00", "Asia/Jakarta", Some(3), Some("HOT")),
            ("2026-09-21 05:00:00", "Asia/Jakarta", Some(4), Some("WARM")),
            ("2026-09-18 05:00:00", "Asia/Jakarta", Some(7), Some("WARM")),
            ("2026-09-17 05:00:00", "Asia/Jakarta", Some(8), Some("COLD")),
            ("2026-09-24 16:30:00", "Asia/Makassar", Some(0), Some("HOT")),
            ("2026-09-24 16:30:00", "Asia/Jakarta", Some(1), Some("HOT")),
            ("2026-09-26 05:00:00", "Asia/Jakarta", Some(0), Some("HOT")),
            ("", "Asia/Jakarta", None, None),
        ];
        for (last, zone, days, segment) in cases {
            let computed = days_since_response(last, now, zone);
            assert_eq!(computed, *days, "{last} {zone}");
            assert_eq!(lead_segment("LEAD", computed, 3, 7), *segment, "{last} {zone}");
        }
        assert_eq!(lead_segment("FIRST_ORDER_ACTIVE", Some(30), 3, 7), None);
        // Batas dari setelan bisnis (vektor kembar `client.test.ts`).
        assert_eq!(lead_segment("LEAD", Some(5), 5, 14), Some("HOT"));
        assert_eq!(lead_segment("LEAD", Some(14), 5, 14), Some("WARM"));
        assert_eq!(lead_segment("LEAD", Some(15), 5, 14), Some("COLD"));
        assert_eq!(lead_segment("LEAD", Some(0), 0, 1), Some("HOT"));
    }

    #[test]
    fn waktu_interaksi() {
        let now = 1790312400;
        assert_eq!(resolve_interaction_time(None, now), Ok(now));
        assert_eq!(resolve_interaction_time(Some(&serde_json::Value::Null), now), Ok(now));
        assert_eq!(resolve_interaction_time(Some(&serde_json::json!(now - 3600)), now), Ok(now - 3600));
        assert_eq!(resolve_interaction_time(Some(&serde_json::json!(now + 300)), now), Ok(now + 300));
        assert_eq!(
            resolve_interaction_time(Some(&serde_json::json!(now + 301)), now),
            Err("The interaction time cannot be in the future.")
        );
        assert_eq!(
            resolve_interaction_time(Some(&serde_json::json!(now - 366 * 86_400 - 1)), now),
            Err("The interaction time cannot be more than a year ago.")
        );
        assert_eq!(
            resolve_interaction_time(Some(&serde_json::json!("kemarin")), now),
            Err("The interaction time is not valid.")
        );
        assert_eq!(
            resolve_interaction_time(Some(&serde_json::json!(1.5)), now),
            Err("The interaction time is not valid.")
        );
    }

    #[test]
    fn batas_hari_perusahaan() {
        assert_eq!(
            company_day_bounds_utc("2026-09-25", "Asia/Jakarta"),
            Some(("2026-09-24 17:00:00".to_owned(), "2026-09-25 17:00:00".to_owned()))
        );
        assert_eq!(
            company_day_bounds_utc("2026-09-25", "Asia/Jayapura"),
            Some(("2026-09-24 15:00:00".to_owned(), "2026-09-25 15:00:00".to_owned()))
        );
        assert_eq!(company_day_bounds_utc("25-09-2026", "Asia/Jakarta"), None);
        assert_eq!(company_day_bounds_utc("", "Asia/Jakarta"), None);
    }
}
