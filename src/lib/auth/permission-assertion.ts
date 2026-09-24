import { hasPermission } from "@/lib/auth/access";
import type { OperatorUser } from "@/lib/auth/operator-user";
import type { PermissionKey } from "@/lib/rbac/catalog";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function assertActorPermission(
  actor: OperatorUser | null,
  permission: PermissionKey,
  superadminOnly = false,
) {
  if (!actor) {
    throw new AuthorizationError("The session is invalid or has ended.", 401);
  }
  if (
    !hasPermission(actor, permission) ||
    (superadminOnly && !actor.isSuperadmin)
  ) {
    throw new AuthorizationError("Access denied for this action.", 403);
  }
  return actor;
}
