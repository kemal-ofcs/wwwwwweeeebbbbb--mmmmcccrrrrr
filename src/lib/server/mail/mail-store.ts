import "server-only";

import type { Client } from "@libsql/client";
import {
  assertMailConfigDraft,
  buildResetEmail,
  isMailProvider,
  type MailConfig,
  type MailConfigDraft,
  type MailProvider,
} from "@/lib/mail/mail-config";

const CONFIG_ID = "default";

interface StoredMailConfig extends MailConfig {
  apiKey: string;
}

/**
 * Membaca konfigurasi email lengkap dengan kuncinya. Hanya untuk pemakaian
 * server — `readMailConfig` adalah versi yang aman dikirim ke klien.
 */
async function readStoredMailConfig(
  client: Client,
): Promise<StoredMailConfig | null> {
  const result = await client.execute({
    sql: `
      SELECT provider, api_key, sender_email, sender_name,
             reset_base_url, is_active, updated_at, updated_by
      FROM app_mail_config WHERE id = ? LIMIT 1;
    `,
    args: [CONFIG_ID],
  });
  const row = result.rows[0];
  if (!row) return null;
  const provider = isMailProvider(row.provider)
    ? (row.provider as MailProvider)
    : "resend";
  const apiKey = row.api_key == null ? "" : String(row.api_key);
  return {
    provider,
    apiKey,
    hasApiKey: apiKey.trim().length > 0,
    senderEmail: row.sender_email == null ? "" : String(row.sender_email),
    senderName: row.sender_name == null ? "" : String(row.sender_name),
    resetBaseUrl: row.reset_base_url == null ? "" : String(row.reset_base_url),
    isActive: Number(row.is_active ?? 0) === 1,
    updatedAt: row.updated_at == null ? "" : String(row.updated_at),
    updatedBy: row.updated_by == null ? "" : String(row.updated_by),
  };
}

/** Konfigurasi tanpa kunci API, aman dikembalikan ke klien. */
export async function readMailConfig(client: Client): Promise<MailConfig> {
  const stored = await readStoredMailConfig(client);
  if (!stored) {
    return {
      provider: "resend",
      hasApiKey: false,
      senderEmail: "",
      senderName: "",
      resetBaseUrl: "",
      isActive: false,
      updatedAt: "",
      updatedBy: "",
    };
  }
  const { apiKey: _apiKey, ...safe } = stored;
  return safe;
}

export async function saveMailConfig(
  client: Client,
  draft: MailConfigDraft,
  actor: string,
) {
  const stored = await readStoredMailConfig(client);
  assertMailConfigDraft(draft, !stored?.hasApiKey);
  // Kunci hanya ditimpa ketika formulir benar-benar mengirim kunci baru:
  // formulir mengirim string kosong setiap kali disimpan karena kunci tidak
  // pernah dikembalikan ke klien.
  const apiKey = draft.apiKey.trim() || (stored?.apiKey ?? "");
  await client.execute({
    sql: `
      INSERT INTO app_mail_config (
        id, provider, api_key, sender_email, sender_name,
        reset_base_url, is_active, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        api_key = excluded.api_key,
        sender_email = excluded.sender_email,
        sender_name = excluded.sender_name,
        reset_base_url = excluded.reset_base_url,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;
    `,
    args: [
      CONFIG_ID,
      draft.provider,
      apiKey,
      draft.senderEmail.trim().toLowerCase(),
      draft.senderName.trim(),
      draft.resetBaseUrl.trim().replace(/\/+$/, ""),
      draft.isActive ? 1 : 0,
      new Date().toISOString(),
      actor,
    ],
  });
  return readMailConfig(client);
}

export interface MailDeliveryResult {
  delivered: boolean;
  /** Pesan untuk pemohon; halaman "Lupa Password" terbuka tanpa login. */
  message: string;
  /**
   * Penjelasan apa adanya dari penyedia email.
   *
   * Disimpan ke `password_reset_request.delivery_error` yang hanya bisa dibaca
   * pemegang izin `password_reset.view`, dan ditampilkan pada uji kirim di
   * Pengaturan. Menyembunyikan ini dari SEMUA orang — seperti versi sebelumnya —
   * membuat kegagalan seperti "domain pengirim belum diverifikasi" mustahil
   * didiagnosis: yang terlihat hanya "HTTP 403" tanpa petunjuk apa pun.
   */
  detail: string;
}

/**
 * Mengirim satu email lewat HTTP API penyedia.
 *
 * Tidak memakai SMTP: aplikasi ini berjalan di Vercel dan di dalam WebView
 * Tauri, dan keduanya tidak menjamin soket keluar port 587. HTTP API bekerja di
 * kedua tempat dengan klien HTTP yang sudah ada.
 */
export async function sendMail(
  client: Client,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<MailDeliveryResult> {
  const config = await readStoredMailConfig(client);
  if (!config?.isActive || !config.apiKey.trim() || !config.senderEmail) {
    return {
      delivered: false,
      message:
        "Email sending is not configured. Ask an Admin to fill in Settings > System email.",
      detail:
        "Email settings are off, the API key is empty, or the sender email is not set.",
    };
  }

  const senderName = config.senderName || "App Template";
  try {
    const response =
      config.provider === "resend"
        ? await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey.trim()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `${senderName} <${config.senderEmail}>`,
              to: [to],
              subject,
              text,
              html,
            }),
          })
        : await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
              "api-key": config.apiKey.trim(),
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              sender: { name: senderName, email: config.senderEmail },
              to: [{ email: to }],
              subject,
              textContent: text,
              htmlContent: html,
            }),
          });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        delivered: false,
        message: `Penyedia email menolak pengiriman (HTTP ${response.status}).`,
        detail: `HTTP ${response.status} dari ${config.provider}: ${body
          .replace(/\s+/g, " ")
          .slice(0, 400)}`,
      };
    }
    return { delivered: true, message: "Email terkirim.", detail: "" };
  } catch (error) {
    return {
      delivered: false,
      detail: `Permintaan ke ${config.provider} gagal: ${
        error instanceof Error ? error.message : "unknown cause"
      }`,
      message:
        "The email could not be sent because no network is available. Try again once the device is online.",
    };
  }
}

/**
 * Mengirim email percobaan ke alamat Admin yang sedang login.
 *
 * Tanpa ini, satu-satunya cara menguji konfigurasi email adalah menjalankan
 * seluruh alur "Lupa Password" sampai verifikasi wajah — dan kegagalannya
 * muncul di layar yang tidak boleh menampilkan penjelasan penyedia. Uji kirim
 * memindahkan diagnosis ke tempat yang memang sudah terlindungi izin.
 */
export async function sendTestMail(client: Client, operatorId: number) {
  const row = await client.execute({
    sql: "SELECT COALESCE(email, '') AS email, nama_operator FROM master_operator WHERE id = ? LIMIT 1;",
    args: [operatorId],
  });
  const to = String(row.rows[0]?.email ?? "").trim();
  if (!to) {
    return {
      delivered: false,
      message:
        "Your account has no registered email. Add your account email on the Operators page first.",
      detail: "",
      to: "",
    };
  }
  const name = String(row.rows[0]?.nama_operator ?? "Admin");
  const result = await sendMail(
    client,
    to,
    "Uji Kirim Email Sistem App Template",
    `Hello ${name},\n\nThis email was sent from Settings > System email to test the sender settings.\nIf it arrived, Forgot password is ready to use.\n\nApp Template`,
    `<p>Hello <strong>${name}</strong>,</p><p>This email was sent from Settings &gt; System email to test the sender settings. If it arrived, Forgot password is ready to use.</p><p>App Template</p>`,
  );
  return { ...result, to };
}

export { buildResetEmail };
