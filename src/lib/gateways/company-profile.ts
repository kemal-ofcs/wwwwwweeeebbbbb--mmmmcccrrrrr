"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Identitas perusahaan pemakai aplikasi.
 *
 * Bagian PLATFORM, bukan domain contoh: jangan hapus bersama `item.ts` dan
 * `activity.ts`. Hampir setiap aplikasi bisnis memerlukannya untuk kop
 * dokumen, cetakan, dan ekspor.
 */
export interface CompanyProfile {
  id: string;
  company_name: string;
  branch_name: string | null;
  logo_url: string | null;
  signature_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  leader_name: string | null;
  leader_title: string | null;
  timezone: string;
  updated_at: string;
}

export type CompanyProfileDraft = Omit<CompanyProfile, "id" | "updated_at">;

/**
 * Batas ukuran gambar yang boleh disimpan, dalam karakter base64.
 *
 * Logo dan tanda tangan disimpan sebagai data URI di dalam baris yang ikut
 * SINKRONISASI, jadi ukurannya menjadi beban setiap perangkat pada setiap
 * siklus tarik. 256 KB base64 (~190 KB biner) sudah jauh lebih dari cukup untuk
 * logo pada kop dokumen.
 */
export const MAX_IMAGE_BASE64_LENGTH = 262_144;

export async function getCompanyProfile(): Promise<CompanyProfile> {
  if (isDesktopRuntime()) {
    return invokeDesktop<CompanyProfile>("desktop_get_company_profile");
  }
  // Route handler Web wajib POST: build Desktop/Mobile memakai
  // `output: "export"` yang tidak dapat melayani GET dinamis.
  const result = await requestWebApi<{ profile: CompanyProfile }>(
    "/api/settings/company/query",
    "POST",
    {},
  );
  return result.profile;
}

export async function saveCompanyProfile(
  draft: CompanyProfileDraft,
): Promise<CompanyProfile> {
  if (isDesktopRuntime()) {
    return invokeDesktop<CompanyProfile>("desktop_update_company_profile", {
      profile: draft,
    });
  }
  const result = await requestWebApi<{ profile: CompanyProfile }>(
    "/api/settings/company",
    "PUT",
    { profile: draft },
  );
  return result.profile;
}
