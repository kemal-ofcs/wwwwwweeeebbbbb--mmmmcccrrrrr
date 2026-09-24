import type { PermissionKey } from "@/lib/rbac/catalog";

/**
 * Area navigasi aplikasi.
 *
 * Tambahkan area baru di sini beserta permission penjaganya, lalu gunakan
 * `canAccessArea` di komponen navigasi. Pola ini menjaga satu sumber kebenaran:
 * menu yang tampil, guard halaman, dan pemeriksaan permission di backend Rust
 * semuanya merujuk daftar permission yang sama.
 */
export type AppArea =
  | "home"
  | "dashboard"
  | "items"
  | "activity"
  | "operators"
  | "password_reset"
  | "settings"
  | "diagnostics";

export interface AccessSubject {
  isSuperadmin: boolean;
  permissions: readonly PermissionKey[];
}

const AREA_PERMISSION: Record<AppArea, PermissionKey> = {
  home: "home.view",
  dashboard: "dashboard.view",
  items: "items.view",
  activity: "activity.view",
  operators: "operators.view",
  password_reset: "password_reset.view",
  settings: "settings.view",
  diagnostics: "diagnostics.view",
};

export function hasPermission(
  subject: AccessSubject | null | undefined,
  permission: PermissionKey,
) {
  if (!subject) return false;
  // Superadmin sengaja tidak diperiksa terhadap daftar permission: role itu
  // memang memegang seluruh katalog, termasuk permission yang baru ditambahkan
  // setelah sesinya dibuat.
  return subject.isSuperadmin || subject.permissions.includes(permission);
}

export function canAccessArea(
  subject: AccessSubject | null | undefined,
  area: AppArea,
) {
  return hasPermission(subject, AREA_PERMISSION[area]);
}
