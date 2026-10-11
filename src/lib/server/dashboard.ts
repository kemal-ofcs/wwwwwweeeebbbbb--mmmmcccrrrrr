import "server-only";

import type { Client, Row } from "@libsql/client";
import { hasPermission } from "@/lib/auth/access";
import type { OperatorUser } from "@/lib/auth/operator-user";
import { ApiRequestError } from "@/lib/server/http/api-response";
import {
  DASHBOARD_SECTION_PERMISSION,
  DASHBOARD_SECTION_SQL,
  DASHBOARD_SECTIONS,
  validateDashboardRange,
} from "@/lib/validations/dashboard";

/**
 * Dashboard eksekutif (F-40a, D-52) — jalur Web. Cermin
 * `desktop_get_dashboard`: hanya bagian yang izinnya dipegang.
 */

function plain(row: Row | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

export async function getDashboard(
  client: Client,
  input: Record<string, unknown>,
  operator: Pick<OperatorUser, "isSuperadmin" | "permissions">,
) {
  const range = validateDashboardRange(input.from, input.to);
  if ("error" in range) throw new ApiRequestError(range.error, 400);
  const sections: Record<string, Record<string, unknown>> = {};
  for (const section of DASHBOARD_SECTIONS) {
    if (!hasPermission(operator, DASHBOARD_SECTION_PERMISSION[section])) {
      continue;
    }
    const result = await client.execute({
      sql: DASHBOARD_SECTION_SQL[section],
      args: [range.from, range.to],
    });
    sections[section] = plain(result.rows[0]);
  }
  return { from: range.from, to: range.to, sections };
}
