import { type AccessSubject, type AppArea, canAccessArea } from "./access";

/**
 * Halaman pertama setelah login, urut prioritas (PRD FR-01.3, keputusan E):
 * Workspace klien untuk CS, lalu Pengaturan untuk Superadmin/Admin yang
 * belum memegang izin klien, lalu Riwayat Reset.
 *
 * Hanya berisi rute yang ADA di Web-Desktop dan Mobile sekaligus (`/operators`
 * hanya ada di Web-Desktop), karena modul ini ikut disalin ke Mobile.
 */
const LANDING_ORDER: readonly (readonly [AppArea, string])[] = [
  ["clients", "/clients"],
  ["settings", "/settings"],
  ["password_reset", "/password-reset-history"],
];

/**
 * Rute pertama yang boleh dibuka akun ini, atau `null` bila tidak ada satu pun
 * — misalnya role Operator bawaan yang tidak memegang `settings.view` tetap
 * mendarat di Clients, bukan di halaman "akses ditolak".
 */
export function landingPath(
  subject: AccessSubject | null | undefined,
): string | null {
  const found = LANDING_ORDER.find(([area]) => canAccessArea(subject, area));
  return found ? found[1] : null;
}
