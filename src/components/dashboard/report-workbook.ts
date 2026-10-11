"use client";

import {
  INVOICE_TYPE_LABEL,
  invoiceStatusLabel,
} from "@/components/finance/labels";
import {
  MATERIAL_STATUS_LABEL,
  SAMPLE_STATUS_LABEL,
  SHIPMENT_STATUS_LABEL,
} from "@/components/samples/labels";
import { type AccessSubject, hasPermission } from "@/lib/auth/access";
import {
  excelDateTime,
  excelDay,
  type XlsxCell,
  type XlsxSheet,
} from "@/lib/documents/xlsx";
import { listClients } from "@/lib/gateways/clients";
import { getCompanyProfile } from "@/lib/gateways/company-profile";
import { getCrmOverview } from "@/lib/gateways/crm";
import type { DashboardData } from "@/lib/gateways/dashboard";
import { getFinanceOverview } from "@/lib/gateways/finance";
import { getProductionOverview } from "@/lib/gateways/production";
import { listSampleRequests } from "@/lib/gateways/samples";
import {
  companyDateStamp,
  parseStoredTimestamp,
} from "@/lib/validations/client";

/**
 * Workbook laporan dashboard (F-40b, D-52): Ringkasan dari angka dashboard,
 * lalu daftar aktivitas periode itu per bidang. Sheet yang izinnya tidak
 * dipegang tidak dibuat dan datanya tidak diambil. Disusun dari gateway yang
 * sama dengan layar masing-masing, jadi tetap jalan offline di perangkat.
 */

type Rows = XlsxCell[][];

/** Tanggal perusahaan (`YYYY-MM-DD`) dari stempel UTC tersimpan. */
function companyDay(stored: string, timezone: string) {
  const epoch = parseStoredTimestamp(stored);
  if (epoch === null) return "";
  const stamp = companyDateStamp(epoch, timezone);
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

function summary(data: DashboardData): Rows {
  const rows: Rows = [
    ["Metric", "Value"],
    ["Period", `${data.from} to ${data.to}`],
  ];
  const add = (label: string, value: number | null | undefined) =>
    rows.push([label, value ?? null]);
  const { sales, samples, finance, production, crm } = data.sections;
  if (sales) {
    add("New leads", sales.leads_new);
    add("Open leads", sales.leads_open);
    add("Open leads: hot", sales.leads_hot);
    add("Open leads: warm", sales.leads_warm);
    add("Open leads: cold", sales.leads_cold);
    add("Leads without a PIC", sales.leads_without_pic);
    add("Lead to first sample (average days)", sales.avg_lead_to_sample_days);
  }
  if (samples) {
    add("New sample requests", samples.samples_new);
    add("Samples sent", samples.samples_sent);
    add("Samples approved by the client", samples.samples_approved);
    add("MoUs accepted", samples.mou_accepted);
    add("Sample requests in progress", samples.samples_in_progress);
    add("RnD turnaround (average days)", samples.avg_rnd_days);
  }
  if (finance) {
    add("Invoices issued", finance.invoices_issued);
    add("Invoiced (IDR)", finance.invoiced_idr);
    add("Money received (IDR)", finance.received_idr);
    add("Outstanding today (IDR)", finance.outstanding_idr);
    add("Overdue today (IDR)", finance.overdue_idr);
    add("Overdue invoices", finance.overdue_count);
    add("Not yet allocated (IDR)", finance.unallocated_idr);
  }
  if (production) {
    add("Work orders waiting to start", production.wo_waiting);
    add("Work orders on the floor", production.wo_floor);
    add("Packed, not shipped", production.wo_packed);
    add("Packed in the period", production.packed);
    add("Packed on schedule", production.packed_on_time);
    add("Behind schedule", production.behind_schedule);
    add("Late purchase orders", production.late_purchase_orders);
    add("Shipped", production.shipped);
    add("Received in good condition", production.received_ok);
    add("Complaints", production.complaints);
    add("Complaints still open", production.claims_open);
    add("QC decisions", production.claims_decided);
    add("QC decisions: our fault", production.claims_internal);
    add("QC decision time (average hours)", production.avg_qc_hours);
  }
  if (crm) {
    add("Orders completed", crm.orders_completed);
    add("CRM clients", crm.crm_clients);
    add("CRM clients without a CRM", crm.crm_unassigned);
    add("Due for a repeat order", crm.crm_due);
    add("Repeat orders started", crm.repeat_started);
  }
  return rows;
}

export async function buildReportSheets(
  user: AccessSubject | null,
  data: DashboardData,
): Promise<{ sheets: XlsxSheet[]; rows: number }> {
  const timezone = await getCompanyProfile()
    .then((profile) => profile.timezone)
    .catch(() => "Asia/Jakarta");
  const inPeriod = (day: string) =>
    day !== "" && day >= data.from && day <= data.to;
  const stamped = (stored: string) => inPeriod(companyDay(stored, timezone));
  const sheets: XlsxSheet[] = [{ name: "Summary", rows: summary(data) }];

  if (hasPermission(user, "clients.view")) {
    const clients = (await listClients()).filter((row) =>
      stamped(row.created_at),
    );
    sheets.push({
      name: "New clients",
      rows: [
        [
          "Client code",
          "Name",
          "WhatsApp",
          "City",
          "Stage",
          "PIC CS",
          "Created",
        ],
        ...clients.map((row) => [
          row.client_code,
          row.name,
          row.phone_normalized,
          row.city,
          row.lifecycle_status,
          row.pic_cs_name ?? "",
          excelDateTime(row.created_at),
        ]),
      ],
    });
    const crm = await getCrmOverview();
    sheets.push({
      name: "CRM",
      rows: [
        [
          "Client code",
          "Client",
          "CRM",
          "Last order",
          "Units",
          "Formula",
          "Completed",
          "Repeat around",
          "Order in progress",
        ],
        ...crm.clients.map((row) => [
          row.client_code,
          row.client_name,
          row.crm_name,
          row.brand_name,
          row.last_units || null,
          row.last_formula_code,
          excelDay(row.last_completed_at.slice(0, 10)),
          excelDay(row.reorder_on),
          row.open_tickets > 0 ? "Yes" : "No",
        ]),
      ],
    });
  }

  if (hasPermission(user, "samples.view")) {
    const samples = (await listSampleRequests()).requests.filter((row) =>
      stamped(row.created_at),
    );
    sheets.push({
      name: "New sample requests",
      rows: [
        [
          "Client code",
          "Client",
          "Brand",
          "Packaging",
          "Status",
          "Repeat order",
          "Deadline",
          "Created",
        ],
        ...samples.map((row) => [
          row.client_code ?? "",
          row.client_name ?? "",
          row.brand_name,
          row.packaging,
          SAMPLE_STATUS_LABEL[row.status] ?? row.status,
          row.repeat_of_id ? "Yes" : "No",
          excelDay(row.deadline_at),
          excelDateTime(row.created_at),
        ]),
      ],
    });
  }

  if (hasPermission(user, "invoices.view")) {
    const finance = await getFinanceOverview();
    sheets.push({
      name: "Invoices",
      rows: [
        [
          "Invoice number",
          "Issued on",
          "Due on",
          "Client code",
          "Client",
          "Brand",
          "For",
          "Total (IDR)",
          "Paid (IDR)",
          "Remaining (IDR)",
          "Status",
        ],
        ...finance.invoices
          .filter((row) => inPeriod(row.issued_on))
          .map((row) => [
            row.invoice_number,
            excelDay(row.issued_on),
            excelDay(row.due_on),
            row.client_code,
            row.client_name,
            row.brand_name,
            INVOICE_TYPE_LABEL[row.ref_type] ?? row.ref_type,
            row.total_idr,
            row.paid_idr,
            Math.max(0, row.total_idr - row.paid_idr),
            invoiceStatusLabel(row),
          ]),
      ],
    });
    sheets.push({
      name: "Incoming payments",
      rows: [
        [
          "Received on",
          "Amount (IDR)",
          "Description",
          "Client code",
          "Allocated (IDR)",
          "Status",
        ],
        ...finance.funds
          .filter((row) => inPeriod(row.received_on))
          .map((row) => [
            excelDay(row.received_on),
            row.amount_idr,
            row.description,
            row.client_code ?? "",
            row.allocated_idr,
            row.status === "VOID" ? "Void" : "Active",
          ]),
      ],
    });
  }

  if (hasPermission(user, "production.view")) {
    const production = await getProductionOverview();
    sheets.push({
      name: "Work orders",
      rows: [
        [
          "Work order",
          "MoU",
          "Client code",
          "Client",
          "Brand",
          "Units",
          "Materials",
          "Stages done",
          "Packing scheduled",
          "Packed",
          "Cartons",
          "Units produced",
        ],
        ...production.batches
          .filter(
            (row) =>
              stamped(row.created_at) ||
              (row.packed_at !== "" && stamped(row.packed_at)),
          )
          .map((row) => [
            row.batch_code,
            row.mou_number,
            row.client_code ?? "",
            row.client_name ?? "",
            row.brand_name,
            row.total_units,
            MATERIAL_STATUS_LABEL[row.material_status] ?? row.material_status,
            `${row.stages_done} of 4`,
            excelDay(row.sched_packing_on),
            row.packed_at ? excelDateTime(row.packed_at) : null,
            row.carton_count || null,
            row.produced_units || null,
          ]),
      ],
    });
    sheets.push({
      name: "Shipments",
      rows: [
        [
          "Delivery note",
          "Ship date",
          "Client code",
          "Client",
          "Brand",
          "Units",
          "Cartons",
          "Shipped by",
          "Tracking",
          "Status",
        ],
        ...production.shipments
          .filter((row) => inPeriod(row.ship_on))
          .map((row) => [
            row.delivery_note_no,
            excelDay(row.ship_on),
            row.client_code ?? "",
            row.client_name ?? "",
            row.brand_name,
            row.unit_count,
            row.carton_count,
            row.method === "FLEET"
              ? `Own fleet: ${row.driver_name}`
              : row.carrier_label,
            row.tracking_no,
            SHIPMENT_STATUS_LABEL[row.status] ?? row.status,
          ]),
      ],
    });
    sheets.push({
      name: "Complaints",
      rows: [
        [
          "Delivery note",
          "Client code",
          "Client",
          "Brand",
          "Reported",
          "Units affected",
          "Complaint",
          "Status",
          "Fault",
          "Decided",
        ],
        ...production.claims
          .filter((row) => stamped(row.created_at))
          .map((row) => [
            row.delivery_note_no,
            row.client_code ?? "",
            row.client_name ?? "",
            row.brand_name,
            excelDateTime(row.created_at),
            row.affected_units || null,
            row.complaint_notes,
            row.status === "OPEN" ? "QC investigating" : "Decided",
            row.fault_type === "INTERNAL"
              ? "Ours"
              : row.fault_type === "RECIPIENT"
                ? "Recipient or courier"
                : "",
            row.decided_at ? excelDateTime(row.decided_at) : null,
          ]),
      ],
    });
  }

  const rows = sheets.reduce((sum, sheet) => sum + sheet.rows.length - 1, 0);
  return { sheets, rows };
}
