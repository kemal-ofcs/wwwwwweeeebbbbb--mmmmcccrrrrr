/**
 * Bentuk konfigurasi pengirim email, dipakai bersama UI Pengaturan dan server.
 *
 * Modul ini sengaja bebas dari `server-only` dan dari `@libsql/client` supaya
 * bisa diimpor komponen klien. Pembacaan/penulisan barisnya ada di
 * `src/lib/server/mail/mail-store.ts`.
 */

export const MAIL_PROVIDERS = ["resend", "brevo"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export interface MailConfig {
  provider: MailProvider;
  /**
   * Kunci API TIDAK pernah dikirim balik ke klien. Nilai di sini selalu berupa
   * penanda "sudah terisi" (`hasApiKey`), bukan kuncinya sendiri.
   */
  hasApiKey: boolean;
  senderEmail: string;
  senderName: string;
  /**
   * Basis URL halaman reset, mis. `https://app.contoh.id`. Bila kosong, email
   * hanya memuat kode reset dan operator memasukkannya manual di aplikasi —
   * jalur yang dipakai pemasangan Desktop tanpa aplikasi Web.
   */
  resetBaseUrl: string;
  isActive: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface MailConfigDraft {
  provider: MailProvider;
  /** Kosong berarti "biarkan kunci yang tersimpan apa adanya". */
  apiKey: string;
  senderEmail: string;
  senderName: string;
  resetBaseUrl: string;
  isActive: boolean;
}

export function isMailProvider(value: unknown): value is MailProvider {
  return (
    typeof value === "string" &&
    (MAIL_PROVIDERS as readonly string[]).includes(value)
  );
}

export const MAIL_PROVIDER_LABEL: Record<MailProvider, string> = {
  resend: "Resend (api.resend.com)",
  brevo: "Brevo (api.brevo.com)",
};

/**
 * Syarat alamat pengirim tiap penyedia.
 *
 * Perbedaan ini menentukan apakah pemasangan butuh biaya: Resend mewajibkan
 * domain terverifikasi (harus punya domain sendiri), sedangkan Brevo cukup satu
 * alamat email yang dikonfirmasi lewat tautan. Ditampilkan tepat di sebelah
 * pilihan penyedia supaya tidak ditemukan setelah berjam-jam gagal mengirim.
 */
export const MAIL_PROVIDER_REQUIREMENT: Record<MailProvider, string> = {
  resend:
    "Requires your own domain verified through DNS records. Without it you can only send from onboarding@resend.dev to the Resend account owner's address.",
  brevo:
    "Verifying one sender address (Gmail works too) through a confirmation link is enough. You do NOT need your own domain. The free plan limits sends per day. Make sure Authorised IPs is turned off in Brevo, because emails are sent directly from operator devices whose IP keeps changing.",
};

/**
 * Validasi draft sebelum disimpan. Melempar pesan siap tampil.
 *
 * `requireApiKey` bernilai true ketika belum ada kunci tersimpan: mengaktifkan
 * pengiriman tanpa kunci hanya akan menghasilkan kegagalan diam pada saat
 * seseorang benar-benar membutuhkan link reset.
 */
export function assertMailConfigDraft(
  draft: MailConfigDraft,
  requireApiKey: boolean,
) {
  if (!isMailProvider(draft.provider)) {
    throw new Error("Unknown email provider.");
  }
  if (!draft.isActive) return;
  if (requireApiKey && !draft.apiKey.trim()) {
    throw new Error("The email provider API key is required.");
  }
  const sender = draft.senderEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(sender)) {
    throw new Error("Enter a valid sender email.");
  }
  if (draft.senderName.trim().length < 2) {
    throw new Error("The sender name needs at least 2 characters.");
  }
  const base = draft.resetBaseUrl.trim();
  if (base && !/^https?:\/\/[^\s]+$/.test(base)) {
    throw new Error(
      "The reset page URL must start with http:// or https:// and contain no spaces.",
    );
  }
}

/** Menyusun isi email reset. Dipakai server; dipisah agar bisa diuji. */
export function buildResetEmail(input: {
  operatorName: string;
  resetLink: string;
  resetCode: string;
  expiresInMinutes: number;
}) {
  const { operatorName, resetLink, resetCode, expiresInMinutes } = input;
  const action = resetLink
    ? `Open this link to create a new password:\n${resetLink}`
    : `Enter this code on the "Forgot password" page in the app:\n${resetCode}`;
  const text = [
    `Hello ${operatorName},`,
    "",
    "We received a password recovery request for your App Template account.",
    "The request passed face verification on the requester's device.",
    "",
    action,
    "",
    `This link or code is valid for ${expiresInMinutes} minutes and can be used once.`,
    "If you did not make this request, ignore this email and report it to your",
    "Admin right away. The requester's photo has been saved as evidence.",
    "",
    "App Template",
  ].join("\n");

  const safeName = escapeHtml(operatorName);
  const htmlAction = resetLink
    ? `<p style="margin:24px 0"><a href="${escapeHtml(resetLink)}" style="background:#0051d5;color:#ffffff;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:700">Create a new password</a></p>`
    : `<p style="margin:24px 0;font-size:24px;letter-spacing:4px;font-weight:800">${escapeHtml(resetCode)}</p>`;
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.6">',
    `<p>Hello <strong>${safeName}</strong>,</p>`,
    "<p>We received a password recovery request for your App Template account. The request passed face verification on the requester's device.</p>",
    htmlAction,
    `<p>This link or code is valid for <strong>${expiresInMinutes} minutes</strong> and can be used once.</p>`,
    "<p>If you did not make this request, ignore this email and report it to your Admin right away. The requester's photo has been saved as evidence.</p>",
    "<p>App Template</p>",
    "</div>",
  ].join("");

  return {
    subject: "App Template password recovery",
    text,
    html,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Menerjemahkan kegagalan penyedia email menjadi instruksi yang bisa dikerjakan.
 *
 * Balasan mentah penyedia ("HTTP 403 dari resend: {...}") benar tetapi tidak
 * memberi tahu apa yang harus dilakukan. Pemetaan ini hidup di sisi TypeScript
 * saja dan dipakai UI di semua platform — Rust cukup meneruskan balasan mentah,
 * sehingga tidak ada dua salinan aturan yang bisa saling drift.
 */
export function describeMailFailure(detail: string): string {
  const lower = detail.toLowerCase();

  if (lower.includes("request to") && lower.includes("failed")) {
    return "The app could not reach the email provider's server. This is not about quota or the API key: check your network DNS, proxy, or firewall.";
  }
  // Brevo punya daftar "Authorised IPs". Bila fitur itu menyala, panggilan API
  // dari IP yang belum terdaftar ditolak 401 — bukan karena kuncinya salah.
  // Dalam arsitektur ini pembatasan IP praktis mustahil dipenuhi: Desktop dan
  // Mobile mengirim email LANGSUNG dari perangkat operator, jadi IP sumbernya
  // adalah jaringan operator itu sendiri dan berubah setiap ganti jaringan.
  if (
    lower.includes("authorised_ip") ||
    lower.includes("authorized_ip") ||
    lower.includes("unrecognised ip") ||
    lower.includes("unrecognized ip") ||
    (lower.includes("ip address") && lower.includes("http 401"))
  ) {
    return "Brevo rejected it because this device's IP address is not on the Authorised IPs list. Your API key itself is correct. The app sends email directly from operator devices, so the IP changes with every network and cannot be registered one by one. Open Brevo > Security > Authorised IPs and TURN OFF the IP restriction.";
  }
  if (lower.includes("http 401") && !lower.includes("sender")) {
    return "The API key was rejected. Copy the key again from the provider dashboard, make sure no spaces were copied, and check that it has not been revoked.";
  }
  if (lower.includes("http 429")) {
    return "The provider's sending quota is full. Wait a few minutes and try again.";
  }
  if (lower.includes("http 403")) {
    // Dua sebab paling umum pada Resend, dan keduanya butuh tindakan berbeda.
    if (lower.includes("verif")) {
      return "The sender email domain is not verified in Resend. Open Resend > Domains, add your domain, and set its DNS records until it shows Verified. For a quick test, use onboarding@resend.dev as the sender email.";
    }
    if (
      lower.includes("testing email") ||
      lower.includes("own email") ||
      lower.includes("sandbox")
    ) {
      return "The Resend account still uses the test domain, so it can only send to the Resend account owner's own address. Verify your domain to send to other addresses.";
    }
    return "The provider rejected this send. The two most common causes: the sender email domain is not verified, or the API key is limited to certain domains. Check both in the provider dashboard.";
  }
  if (
    lower.includes("http 422") ||
    lower.includes("http 400") ||
    lower.includes("http 401")
  ) {
    const menyebutPengirim = lower.includes("from") || lower.includes("sender");
    const belumTerdaftar =
      lower.includes("not valid") ||
      lower.includes("not found") ||
      lower.includes("not registered") ||
      lower.includes("unauthoris") ||
      lower.includes("unauthoriz") ||
      lower.includes("does not exist");
    if (menyebutPengirim && belumTerdaftar) {
      return "The sender email is not registered with the provider. In Brevo: open Senders, Domains & Dedicated IPs > Senders, add the address, then click the confirmation link sent to it. This does NOT require your own domain.";
    }
    if (menyebutPengirim) {
      return "The sender email was rejected. Enter one complete address that is verified with the provider, for example operations.example@gmail.com.";
    }
    return "The provider rejected the message content. Check the sender email and sender name again.";
  }
  if (
    lower.includes("settings are off") ||
    lower.includes("api key is empty")
  ) {
    return "Fill in the API key and sender email, then turn on sending before testing.";
  }
  return "";
}
