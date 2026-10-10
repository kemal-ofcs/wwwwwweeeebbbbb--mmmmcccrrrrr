"use client";

import { requestWebApi } from "@/lib/client/api-client";
import type { InvoiceRecord } from "@/lib/gateways/finance";
import type {
  BatchRecord,
  PurchaseOrderRecord,
  SupplierOption,
} from "@/lib/gateways/production";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { DesignAction, DesignStatus } from "@/lib/validations/design";
import type { LegalRecord } from "@/lib/validations/legal";
import type {
  MouAction,
  MouStatus,
  RegulatoryPath,
} from "@/lib/validations/mou";
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
  rnd_reject_reason_option_id: string;
  /** Tarif revisi dari Finance (v2.2); null = belum ditetapkan. */
  revision_fee_idr: number | null;
  /** Harga jual iterasi yang sedang berjalan; null = belum diberi harga. */
  unit_price_idr: number | null;
  /** 1 = sampel sekalian diuji (D-30). */
  is_test_requested: number;
  /** 1 = tagihan biaya sampel/revisi yang sedang ditunggu sudah lunas. */
  fee_paid: number;
  /** 1 = tagihan uji sudah lunas. */
  test_paid: number;
  /** Status tiket desain aktif (v2.4); null = tanpa tiket desain. */
  design_status: string | null;
  /** Putaran dummy tiket desain aktif; null = tanpa tiket desain. */
  dummy_round: number | null;
  /** 1 = tiket tidak butuh mockup atau mockup sudah diunggah (D-36). */
  mockup_ready: number;
  /** Status MoU aktif (v2.5a); null = belum ada. */
  mou_status: string | null;
  /** Nominal DP dari MoU yang disetujui klien; null = belum ada. */
  mou_dp_idr: number | null;
  /** 1 = tagihan DP Produksi & Legal lunas atau dijadwal ulang. */
  dp_paid: number;
  /** Dokumen legal wajib yang belum final (v2.6); null = belum ada MoU disetujui. */
  legal_open: number | null;
  /**
   * 1 = tagihan dummy putaran berjalan lunas (aturan `DESIGN_LIST_SQL`);
   * null = tidak ada tiket desain aktif.
   */
  dummy_paid: number | null;
  /**
   * 1 = MoU terakhir ditolak atau dibatalkan (order berhenti setelah ACC);
   * null = belum pernah ada MoU.
   */
  mou_closed: number | null;
  /** Status bahan work order (v3.1); null = belum ada work order. */
  batch_material: string | null;
  /** Tanggal packing terjadwal; '' = belum dijadwalkan SPV. */
  batch_packing_on: string | null;
}

/**
 * Harga Finance satu iterasi (v2.2). Rincian biaya dan margin hanya terisi
 * untuk pemegang `pricing.view`; yang lain menerima harga jualnya saja.
 */
export interface SamplePriceEntry {
  id: string;
  iteration_number: number;
  final_unit_price_idr: number;
  notes: string;
  recorded_by: number | null;
  recorded_by_name: string | null;
  recorded_at: string;
  raw_material_cost_idr?: number;
  packaging_cost_idr?: number;
  operational_cost_idr?: number;
  regulatory_cost_idr?: number;
  hpp_unit_idr?: number;
  margin_bp?: number;
}

/** Isian form harga; harga jual dihitung backend. */
export interface SamplePriceInput {
  raw_material_cost_idr: number;
  packaging_cost_idr: number;
  operational_cost_idr: number;
  regulatory_cost_idr: number;
  margin_bp: number;
  notes: string;
}

/** Formula satu sampel yang selesai dibuat RnD (v2.1), satu per iterasi. */
export interface SampleFormulaEntry {
  id: string;
  iteration_number: number;
  formula_code: string;
  product_knowledge: string;
  rnd_notes: string;
  recorded_by: number | null;
  recorded_by_name: string | null;
  recorded_at: string;
}

/** Tiket lain yang memakai formula code yang sama. */
export interface SampleFormulaMatch {
  formula_code: string;
  sample_request_id: string;
  brand_name: string;
  status: string;
  client_code: string | null;
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
  purpose: string;
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
  formulas: SampleFormulaEntry[];
  formula_matches: SampleFormulaMatch[];
  prices: SamplePriceEntry[];
  /** Tagihan milik tiket ini (v2.3a). */
  invoices: InvoiceRecord[];
  /** Tiket desain aktif, atau yang terakhir dibatalkan (v2.4); null = belum ada. */
  design: DesignTicketRecord | null;
  /** Setelan `max_dummy_rejections`; 0 = tanpa batas. */
  max_dummy_rejections: number;
  /** MoU aktif, atau yang terakhir dibatalkan/ditolak (v2.5a); null = belum ada. */
  mou: MouRecord | null;
  /** Setelan persen DP bawaan, untuk form MoU baru. */
  dp_percentage_bp: number;
  /** Alamat Web persetujuan disetel: tombol tautan ditawarkan (v2.5b). */
  approval_link_enabled: boolean;
  /** Dokumen legal semua MoU tiket ini (v2.6). */
  legal_documents: LegalDocumentRecord[];
  /** Work order tiket ini (v3.1); null = PPIC belum membuatnya. */
  batch: BatchRecord | null;
  purchase_orders: PurchaseOrderRecord[];
  /** Pilihan supplier untuk form PO. */
  suppliers: SupplierOption[];
}

/** Satu baris `LEGAL_LIST_SQL` (v2.6, PRD F-21). */
export interface LegalDocumentRecord extends LegalRecord {
  id: string;
  mou_id: string;
  sample_request_id: string;
  updated_by: number | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Satu baris `MOU_LIST_SQL` (v2.5a, PRD F-20). */
export interface MouRecord {
  id: string;
  mou_number: string;
  sample_request_id: string;
  client_id: string;
  total_units: number;
  unit_price_idr: number;
  total_production_cost_idr: number;
  production_lead_time_days: number;
  regulatory_path: RegulatoryPath;
  dp_bp: number;
  dp_amount_required_idr: number;
  notes: string;
  status: MouStatus;
  revision_notes: string;
  status_changed_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  brand_name: string;
  client_code: string | null;
  client_name: string | null;
  client_address: string | null;
  client_city: string | null;
  client_province: string | null;
  /** 1 = tiket tidak meminta dummy atau dummy sudah di-ACC (E-20). */
  dummy_ready: number;
  /** 1 = tagihan DP sudah diterbitkan. */
  dp_invoiced: number;
  /** 1 = tagihan DP lunas atau sisanya dijadwal ulang (keputusan F). */
  dp_cleared: number;
}

/** Isi form MoU; harga satuan dan persen DP hanya dibaca untuk `finance.manage`. */
export interface MouTermsInput {
  total_units: number;
  unit_price_idr: number;
  production_lead_time_days: number;
  regulatory_path: RegulatoryPath;
  dp_bp: number;
  notes: string;
}

/** Satu baris `DESIGN_LIST_SQL` (v2.4, PRD F-19). */
export interface DesignTicketRecord {
  id: string;
  sample_request_id: string;
  brief: string;
  status: DesignStatus;
  dummy_rejection_count: number;
  dummy_tracking_no: string;
  revision_notes: string;
  status_changed_at: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  sample_status: string;
  /** 1 = tiket sampel punya foto mockup. */
  has_mockup: number;
  /** 1 = gerbang bayar putaran dummy ini terbuka (keputusan D). */
  dummy_paid: number;
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
  /** Sampel sekalian diuji (D-30); hanya bisa diubah selama `DRAFT`. */
  is_test_requested: boolean;
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
  /** Isian langkah RnD (`validateRndStep`); diabaikan langkah lain. */
  rnd: {
    product_class: string;
    reject_reason_option_id: string;
    formula_code: string;
    product_knowledge: string;
  };
  /** Wajib untuk `SET_REVISION_FEE` (0 = dibebaskan); diabaikan aksi lain. */
  revision_fee_idr: number | null;
  /** Tangkapan layar balasan klien (WebP base64); wajib untuk jawaban klien (v2.5b). */
  evidence_base64: string;
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
      rnd: {
        product_class: step.rnd.product_class,
        reject_reason_option_id: step.rnd.reject_reason_option_id,
        formula_code: step.rnd.formula_code,
        product_knowledge: step.rnd.product_knowledge,
      },
      revisionFeeIdr: step.revision_fee_idr,
      evidenceBase64: step.evidence_base64 || null,
    });
  }
  return requestWebApi("/api/samples/step", "POST", step);
}

/** Brief desain baru untuk tiket sampel (v2.4, PRD F-19). */
export async function createDesignTicket(
  sampleId: string,
  brief: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_design_ticket", { sampleId, brief });
  }
  return requestWebApi("/api/samples/design", "POST", {
    sample_id: sampleId,
    brief,
  });
}

/** Satu langkah tiket desain; resi hanya dibaca pada `DUMMY_SENT`. */
export async function recordDesignStep(step: {
  id: string;
  action: DesignAction;
  notes: string;
  tracking_no: string;
  /** Wajib untuk jawaban klien atas dummy (v2.5b). */
  evidence_base64: string;
}): Promise<{ status: string; rejection_count: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_design_step", {
      id: step.id,
      action: step.action,
      notes: step.notes,
      trackingNo: step.tracking_no,
      evidenceBase64: step.evidence_base64 || null,
    });
  }
  return requestWebApi("/api/samples/design/step", "POST", step);
}

/** Draf MoU untuk tiket yang sudah disetujui klien (v2.5a). */
export async function createMou(
  sampleId: string,
  terms: MouTermsInput,
): Promise<{ id: string; mou_number: string }> {
  const body = { ...terms };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_mou", { sampleId, terms: body });
  }
  return requestWebApi("/api/samples/mou", "POST", {
    sample_id: sampleId,
    terms: body,
  });
}

/** Ubah draf MoU. */
export async function updateMou(
  id: string,
  terms: MouTermsInput,
): Promise<{ id: string }> {
  const body = { ...terms };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_update_mou", { id, terms: body });
  }
  return requestWebApi("/api/samples/mou/update", "POST", { id, terms: body });
}

/** Satu langkah MoU: kirim, jawaban klien, atau batal. */
export async function recordMouStep(step: {
  id: string;
  action: MouAction;
  notes: string;
  /** Wajib untuk jawaban klien atas MoU (v2.5b). */
  evidence_base64: string;
}): Promise<{ status: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_mou_step", {
      id: step.id,
      action: step.action,
      notes: step.notes,
      evidenceBase64: step.evidence_base64 || null,
    });
  }
  return requestWebApi("/api/samples/mou/step", "POST", step);
}

/** Catat satu dokumen legal; foto dokumen opsional (v2.6). */
export async function recordLegalDocument(
  mouId: string,
  document: LegalRecord,
  evidenceBase64: string,
): Promise<{ id: string; status: string }> {
  const body = { ...document };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_legal_document", {
      mouId,
      document: body,
      evidenceBase64: evidenceBase64 || null,
    });
  }
  return requestWebApi("/api/samples/legal", "POST", {
    mou_id: mouId,
    document: body,
    evidence_base64: evidenceBase64,
  });
}

/** Harga Finance untuk iterasi tiket yang sedang `SAMPLE_READY` (v2.2). */
export async function recordSamplePrice(
  id: string,
  price: SamplePriceInput,
): Promise<{ id: string; final_unit_price_idr: number }> {
  const body = {
    raw_material_cost_idr: price.raw_material_cost_idr,
    packaging_cost_idr: price.packaging_cost_idr,
    operational_cost_idr: price.operational_cost_idr,
    regulatory_cost_idr: price.regulatory_cost_idr,
    margin_bp: price.margin_bp,
    notes: price.notes,
  };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_sample_price", { id, price: body });
  }
  return requestWebApi("/api/samples/price", "POST", { id, price: body });
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
