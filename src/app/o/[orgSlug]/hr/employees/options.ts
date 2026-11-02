import type { employeeFormOptions } from "@/modules/hr/service";

/** Select options for the employee form. */
export function optionsFor(o: Awaited<ReturnType<typeof employeeFormOptions>>) {
  return {
    branches: o.branches.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` })),
    departments: o.departments.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
    managers: o.managers.map((m) => ({
      value: m.id,
      label: `${m.firstName} ${m.lastName} (${m.number})`,
    })),
    members: o.members.map((u) => ({ value: u.id, label: `${u.name} <${u.email}>` })),
  };
}
