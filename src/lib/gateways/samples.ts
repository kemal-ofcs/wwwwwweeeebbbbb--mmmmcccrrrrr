"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  BusinessSettings,
  SampleAction,
  SampleFeeMode,
} from "@/lib/validations/sample";

/**
 * Gateway tiket sampel (PRD F-06) dan setelan bisnis (F-11). Tauri:
 * `desktop_*_sample_*` / `desktop_*_business_settings` membaca SQLite lokal
 * dan mengantre outbox. Web: `/api/samples/*` dan `/api/settings/business`.
 */

export type { BusinessSettings, SampleAction, SampleFeeMode };

/** Satu baris `sample_requests` ditambah nama klien dan PIC CRM. */
export interface SampleRequestRecord {
  id: string;
  client_id: string;
  lead_id: string;
  client_code: string | null;
  client_name: string | null;
  free_revision_limit: number | null;
  sample_kind_option_id: string;
  formulation_type_option_id: string;
  registration_category_option_id: string;
  rnd_product_class: string;
  product_category_option_id: string;
  pic_crm_id: number | null;
  pic_crm_name: string | null;
  sample_qty: number;
  brand_name: string;
  bpom_product_name: string;
  claims: string;
  packaging: string;
  reference_notes: string;
  client_budget_idr: number | null;
  special_requests_json: string;
  deadline_at: string;
  ship_to_address: string;
  is_dummy_required: number;
  is_paid_sample: number;
  revision_index: number;
  is_billable: number;
  status: string;
  rnd_lead_time_days: number | null;
  sent_at: string;
  status_changed_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface SampleStatusLogEntry {
  id: string;
  from_status: string;
  to_status: string;
  action: string;
  notes: string;
  on_behalf_of_division: string;
  recorded_by: number | null;
  recorded_by_name: string | null;
  recorded_at: string;
}

export interface SampleFeedbackEntry {
  id: string;
  iteration_number: number;
  client_decision: string;
  client_notes: string;
  recorded_at: string;
}

/** Data ringkas satu foto; isinya diambil terpisah lewat `getMedia`. */
export interface SampleMediaEntry {
  id: string;
  purpose: "REFERENCE" | "PAYMENT_PROOF";
  byte_size: number;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  /** 1 = isinya sudah ada di perangkat ini (Web selalu 1). */
  has_data: number;
}

export interface SampleDetail {
  request: SampleRequestRecord;
  status_log: SampleStatusLogEntry[];
  feedbacks: SampleFeedbackEntry[];
  media: SampleMediaEntry[];
}

export interface SampleList {
  requests: SampleRequestRecord[];
  sample_fee_mode: SampleFeeMode;
}

/**
 * Isian form tiket. `client_id` hanya dibaca saat membuat; `id` hanya saat
 * mengubah. `is_paid_sample` `null` = ikut setelan perusahaan (FREE/PAID).
 */
export interface SampleDraftInput {
  id: string;
  client_id: string;
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
  special_requests: {
    color: string;
    texture: string;
    size: string;
    aroma: string;
  };
  deadline_at: string;
  ship_to_address: string;
  is_dummy_required: boolean;
  is_paid_sample: boolean | null;
}

export async function listSampleRequests(): Promise<SampleList> {
  if (isDesktopRuntime()) {
    return invokeDesktop<SampleList>("desktop_list_sample_requests");
  }
  const result = await requestWebApi<SampleList>("/api/samples/query", "POST");
  return {
    requests: result.requests ?? [],
    sample_fee_mode: result.sample_fee_mode,
  };
}

export async function getSampleRequest(id: string): Promise<SampleDetail> {
  if (isDesktopRuntime()) {
    return invokeDesktop<SampleDetail>("desktop_get_sample_request", { id });
  }
  return requestWebApi<SampleDetail>("/api/samples/detail/query", "POST", {
    id,
  });
}

export async function createSampleRequest(
  request: SampleDraftInput,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ id: string }>("desktop_create_sample_request", {
      request,
    });
  }
  return requestWebApi<{ id: string }>("/api/samples", "POST", { request });
}

export async function updateSampleRequest(
  request: SampleDraftInput,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ id: string }>("desktop_update_sample_request", {
      request,
    });
  }
  return requestWebApi<{ id: string }>("/api/samples", "PUT", { request });
}

export interface SampleStepInput {
  id: string;
  action: SampleAction;
  notes: string;
  /** Wajib untuk `RND_ACCEPT`; diabaikan aksi lain. */
  lead_time_days: number | null;
}

export async function recordSampleStep(
  step: SampleStepInput,
): Promise<{ status: string; revision_index: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_sample_step", {
      id: step.id,
      action: step.action,
      notes: step.notes,
      leadTimeDays: step.lead_time_days,
    });
  }
  return requestWebApi("/api/samples/step", "POST", step);
}

export async function getBusinessSettings(): Promise<BusinessSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop<BusinessSettings>("desktop_get_business_settings");
  }
  const result = await requestWebApi<{ settings: BusinessSettings }>(
    "/api/settings/business/query",
    "POST",
  );
  return result.settings;
}

export async function saveBusinessSettings(
  settings: BusinessSettings,
): Promise<BusinessSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop<BusinessSettings>("desktop_save_business_settings", {
      settings,
    });
  }
  const result = await requestWebApi<{ settings: BusinessSettings }>(
    "/api/settings/business",
    "PUT",
    { settings },
  );
  return result.settings;
}

/** Unggah satu foto yang SUDAH dikompresi (`compressImageToWebp`). */
export async function uploadSampleMedia(
  sampleId: string,
  purpose: SampleMediaEntry["purpose"],
  dataBase64: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ id: string }>("desktop_upload_sample_media", {
      sampleId,
      purpose,
      dataBase64,
    });
  }
  return requestWebApi<{ id: string }>("/api/samples/media", "POST", {
    sample_id: sampleId,
    purpose,
    data_base64: dataBase64,
  });
}

/**
 * Isi satu foto sebagai data URL. Di perangkat: dari penyimpanan lokal, atau
 * dari database lalu disimpan lokal sehingga sesudahnya terlihat offline.
 */
export async function getMediaDataUrl(id: string): Promise<string> {
  const result = isDesktopRuntime()
    ? await invokeDesktop<{ mime: string; data_base64: string }>(
        "desktop_get_media",
        { id },
      )
    : await requestWebApi<{ mime: string; data_base64: string }>(
        "/api/samples/media/query",
        "POST",
        { id },
      );
  return `data:${result.mime};base64,${result.data_base64}`;
}
