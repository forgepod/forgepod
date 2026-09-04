/**
 * Every permission decision in ForgePod is this file. No I/O, no framework, no database,
 * so the whole rule set can be read in one screen and tested as a table.
 *
 * Written by hand rather than through Better Auth's access-control statements: the
 * resources here are agents, plugins, templates, hooks and people, and configuring `ac`
 * to describe them is more moving parts than one function that answers yes or no.
 */
export type Role = "owner" | "editor" | "runner";

export type Actor = { userId: string; role: Role };

/** The row a row-scoped action is asked about. Only `agent.delete` needs one today. */
export type Resource = { ownerId: string | null };

export type Action =
  | "admin.read"
  | "agent.create"
  | "agent.edit"
  | "agent.delete"
  | "agent.run"
  | "approval.resolve"
  | "hook.bind"
  | "plugin.rescan"
  | "plugin.setTrust"
  | "template.install"
  | "user.manage";

const ROLES: readonly string[] = ["owner", "editor", "runner"];

export const isRole = (value: string): value is Role => ROLES.includes(value);

/**
 * `hook.bind` and `plugin.setTrust` are owner-only because they are the same trust
 * boundary seen twice. `bindHook` refuses a filter hook from an untrusted plugin, and
 * `setTrust` is what makes a plugin trusted. An editor holding both can remove a guard
 * filter, which would leave the roles decorative.
 */
const BY_ROLE: Record<Exclude<Action, "agent.delete">, readonly Role[]> = {
  "admin.read": ["owner", "editor", "runner"],
  "agent.create": ["owner", "editor"],
  "agent.edit": ["owner", "editor"],
  "agent.run": ["owner", "editor", "runner"],
  "approval.resolve": ["owner", "editor"],
  "hook.bind": ["owner"],
  "plugin.rescan": ["owner", "editor"],
  "plugin.setTrust": ["owner"],
  "template.install": ["owner", "editor"],
  "user.manage": ["owner"],
};

export function can(actor: Actor, action: Action, resource?: Resource): boolean {
  if (action === "agent.delete") {
    // Deleting an agent deletes every run recorded against it, so this is the one action
    // scoped to the row rather than to the role. Asked without the row, it refuses: a
    // caller that lost the resource is a caller whose check no longer means anything.
    if (!resource) return false;
    if (actor.role === "owner") return true;
    return actor.role === "editor" && resource.ownerId === actor.userId;
  }

  return BY_ROLE[action].includes(actor.role);
}
