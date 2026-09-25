import "server-only";

import type { Client, Transaction } from "@libsql/client";
import { type AuditActor, writeAudit } from "@/lib/server/audit";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  BUSINESS_SETTING_KEYS,
  type BusinessSettings,
  readBusinessSettings,
  validateBusinessSettings,
} from "@/lib/validations/sample";

/**
 * Setelan bisnis per perusahaan (PRD FR-11) — jalur Web. Cermin
 * `desktop_get_business_settings` / `desktop_save_business_settings`.
 */

const KEYS = Object.values(BUSINESS_SETTING_KEYS);

export async function loadBusinessSettings(
  executor: Client | Transaction,
): Promise<BusinessSettings> {
  const result = await executor.execute({
    sql: `SELECT key, value FROM setting_gex_system WHERE key IN (${KEYS.map(() => "?").join(", ")});`,
    args: KEYS,
  });
  return readBusinessSettings(
    Object.fromEntries(
      result.rows.map((row) => [String(row.key), String(row.value ?? "")]),
    ),
  );
}

/** Berlaku untuk data yang dibuat SESUDAHNYA (kriteria terima FR-11). */
export async function saveBusinessSettings(
  client: Client,
  draft: Record<string, unknown>,
  actor: AuditActor,
): Promise<BusinessSettings> {
  const checked = validateBusinessSettings(draft);
  if ("error" in checked) throw new ApiRequestError(checked.error, 400);
  const settings = checked.settings;
  const transaction = await client.transaction("write");
  try {
    for (const [field, key] of [
      [
        "default_free_revision_limit",
        BUSINESS_SETTING_KEYS.defaultFreeRevisionLimit,
      ],
      ["sample_fee_mode", BUSINESS_SETTING_KEYS.sampleFeeMode],
      ["lead_hot_max_days", BUSINESS_SETTING_KEYS.leadHotMaxDays],
      ["lead_warm_max_days", BUSINESS_SETTING_KEYS.leadWarmMaxDays],
      ["max_photos_per_sample", BUSINESS_SETTING_KEYS.maxPhotosPerSample],
    ] as const) {
      await transaction.execute({
        sql: "INSERT INTO setting_gex_system (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        args: [key, String(settings[field])],
      });
    }
    await writeAudit(
      transaction,
      actor,
      "settings.business",
      "setting",
      "business",
      { ...settings },
    );
    await transaction.commit();
    return settings;
  } finally {
    transaction.close();
  }
}
