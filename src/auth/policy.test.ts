import { expect, test } from "bun:test";
import { can, isRole, type Action, type Actor, type Role } from "./policy";

const actor = (role: Role, userId = "u1"): Actor => ({ userId, role });

// The matrix from the design, as data. A row here is the whole rule for one action, so a
// change in policy.ts that is not also a change here shows up as a failure rather than as
// a quietly widened permission.
const matrix: Array<[Action, Role[]]> = [
  ["admin.read", ["owner", "editor", "runner"]],
  ["agent.create", ["owner", "editor"]],
  ["agent.edit", ["owner", "editor"]],
  ["agent.run", ["owner", "editor", "runner"]],
  ["approval.resolve", ["owner", "editor"]],
  ["hook.bind", ["owner"]],
  ["plugin.rescan", ["owner", "editor"]],
  ["plugin.setTrust", ["owner"]],
  ["template.install", ["owner", "editor"]],
  ["user.manage", ["owner"]],
];

const roles: Role[] = ["owner", "editor", "runner"];

test("every action allows exactly the roles the design names", () => {
  for (const [action, allowed] of matrix) {
    for (const role of roles) {
      expect({ action, role, can: can(actor(role), action) }).toEqual({
        action,
        role,
        can: allowed.includes(role),
      });
    }
  }
});

test("an editor deletes only the agents they own", () => {
  const editor = actor("editor", "u1");
  expect(can(editor, "agent.delete", { ownerId: "u1" })).toBe(true);
  expect(can(editor, "agent.delete", { ownerId: "u2" })).toBe(false);
  // Null means the install owns it, and an editor is not the install.
  expect(can(editor, "agent.delete", { ownerId: null })).toBe(false);
});

test("an owner deletes anything, including what nobody owns", () => {
  const owner = actor("owner", "u9");
  expect(can(owner, "agent.delete", { ownerId: "u1" })).toBe(true);
  expect(can(owner, "agent.delete", { ownerId: null })).toBe(true);
});

test("a runner deletes nothing, not even its own", () => {
  expect(can(actor("runner", "u1"), "agent.delete", { ownerId: "u1" })).toBe(false);
});

// A row-scoped action asked without its row is a caller bug, and answering "yes" to it is
// how a guard gets bypassed by a refactor. Refuse instead.
test("agent.delete without a resource refuses rather than assuming", () => {
  expect(can(actor("owner"), "agent.delete")).toBe(false);
});

test("a role that is not one of the three is not a role", () => {
  expect(isRole("owner")).toBe(true);
  expect(isRole("admin")).toBe(false);
  expect(isRole("")).toBe(false);
});
