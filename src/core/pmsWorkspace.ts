/**
 * Role-based PMS workspace model (Owner, Front desk, Restaurant, Housekeeping).
 * Keeps types and inference here to avoid circular imports with admin routes.
 */

export type PmsWorkspaceId = "owner" | "front_desk" | "restaurant" | "housekeeping";

const WORKSPACE_ORDER: PmsWorkspaceId[] = ["owner", "front_desk", "restaurant", "housekeeping"];

/** Loose matrix shape compatible with admin PermissionMatrix. */
export type PermissionMatrixLike = Record<string, Record<string, boolean>>;

export function matrixRowAllows(
  perm: PermissionMatrixLike,
  module: string,
  action: "VIEW" | "EDIT" | "CREATE" | "DELETE" | "MANAGE"
): boolean {
  const row = perm[module];
  if (!row) return false;
  return Boolean(row.MANAGE || row[action]);
}

export function listAccessibleWorkspaces(role: string, perm: PermissionMatrixLike): PmsWorkspaceId[] {
  if (role === "HOUSEKEEPING") {
    return ["housekeeping"];
  }
  const acc = new Set<PmsWorkspaceId>();

  if (role === "OWNER" || role === "MANAGER" || role === "FINANCE") {
    acc.add("owner");
  } else if (matrixRowAllows(perm, "REPORTS", "VIEW") || matrixRowAllows(perm, "BILLING", "VIEW")) {
    acc.add("owner");
  }

  if (role === "FRONTDESK" || matrixRowAllows(perm, "BOOKINGS", "VIEW") || matrixRowAllows(perm, "ROOMS", "VIEW")) {
    acc.add("front_desk");
  }

  if (role === "RESTAURANT" || matrixRowAllows(perm, "OUTLET", "VIEW")) {
    acc.add("restaurant");
  }

  if (matrixRowAllows(perm, "HOUSEKEEPING", "VIEW")) {
    acc.add("housekeeping");
  }

  return WORKSPACE_ORDER.filter((w) => acc.has(w));
}

export function inferDefaultWorkspace(role: string, perm: PermissionMatrixLike): PmsWorkspaceId {
  const acc = listAccessibleWorkspaces(role, perm);
  if (!acc.length) {
    return "front_desk";
  }
  if (role === "HOUSEKEEPING") return "housekeeping";
  if (role === "OWNER") {
    if (acc.includes("front_desk")) return "front_desk";
    if (acc.includes("owner")) return "owner";
    return acc[0];
  }
  if (role === "FINANCE") return acc.includes("owner") ? "owner" : acc[0];
  if (role === "MANAGER") return acc.includes("front_desk") ? "front_desk" : acc[0];
  if (role === "FRONTDESK") return acc.includes("front_desk") ? "front_desk" : acc[0];
  if (role === "RESTAURANT") return acc.includes("restaurant") ? "restaurant" : acc[0];
  if (acc.includes("front_desk")) return "front_desk";
  if (acc.includes("restaurant")) return "restaurant";
  return acc[0];
}

export function workspaceHomeUrl(workspace: PmsWorkspaceId, role: string): string {
  if (workspace === "housekeeping" && role === "HOUSEKEEPING") {
    return "/admin/hk";
  }
  switch (workspace) {
    case "owner":
      return "/admin/module/owner";
    case "front_desk":
      return "/admin/module/front-desk";
    case "restaurant":
      return "/admin/module/restaurant";
    case "housekeeping":
      return "/admin/module/housekeeping";
    default:
      return "/admin/profile";
  }
}

export function parseWorkspaceFromBody(raw: string): PmsWorkspaceId | null {
  const v = String(raw ?? "").trim();
  if (v === "owner" || v === "front_desk" || v === "restaurant" || v === "housekeeping") {
    return v;
  }
  return null;
}
