import { beforeAll, describe, expect, it } from "vitest";
import { attentionItems } from "@/modules/analytics/attention";
import { addDays, businessDate } from "@/modules/inventory/rules";
import { createBranch } from "@/modules/sites/branches";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import {
  createEquipment,
  getEquipment,
  listEquipment,
  recordCalibration,
  recordMaintenance,
  retireEquipment,
  returnEquipmentToService,
  setEquipmentOutOfService,
} from "./equipment";
import { createCheckpoint } from "./service";

/** Equipment, calibration and maintenance (ADR-099). */

let ctx: TenantContext; // owner
let staff: TenantContext; // records food safety at Cairo, does not manage
let cairo: string;
let today: string;

async function expectRule(promise: Promise<unknown>, rule: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; details?: { rule?: string } };
    expect(`${e.code}:${e.details?.rule}`).toBe(`BUSINESS_RULE_VIOLATION:${rule}`);
    return;
  }
  throw new Error(`Expected ${rule} but the call succeeded`);
}

beforeAll(async () => {
  ({ ctx } = await createTenant("equipment"));
  today = businessDate(ctx.timeZone);
  cairo = (await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT" })).id;
  staff = (await addMember(ctx, "warehouse", { scopeType: "BRANCH", branchId: cairo })).ctx;
});

describe("equipment (ADR-099)", () => {
  it("calibrates a probe: a pass sets the next date, a failure takes it out of service with an NC", async () => {
    const cooking = (
      await createCheckpoint(ctx, {
        branchId: cairo,
        code: "COOK",
        name: "Grill core",
        kind: "COOKING",
        minCelsius: "75",
      })
    ).id;
    const probe = await createEquipment(ctx, {
      branchId: cairo,
      code: "probe-1",
      name: "Probe thermometer",
      type: "THERMOMETER",
      serialNumber: "TP-3001",
      checkpointId: cooking,
      calibrationIntervalDays: "30",
    });
    expect(probe.code).toBe("PROBE-1");
    await expectAppError(
      createEquipment(ctx, { branchId: cairo, code: "PROBE-1", name: "x", type: "THERMOMETER" }),
      "CONFLICT",
    );
    await expectAppError(
      createEquipment(staff, { branchId: cairo, code: "P2", name: "x", type: "THERMOMETER" }),
      "FORBIDDEN",
    );
    // Never calibrated with an interval set: due now.
    expect((await getEquipment(ctx, probe.id)).calibrationState).toBe("DUE_SOON");

    await expectRule(
      recordCalibration(staff, probe.id, {
        performedOn: today,
        performedBy: "Shift lead",
        referenceValue: "0",
        readingValue: "0.4",
      }),
      "CALIBRATION_INCOMPLETE",
    );
    await expectRule(
      recordCalibration(staff, probe.id, {
        performedOn: addDays(today, 1),
        performedBy: "x",
        result: "PASS",
      }),
      "DATE_IN_FUTURE",
    );
    // Ice point: 0 °C ± 1, reads 0.4 → pass, next in 30 days.
    const pass = await recordCalibration(staff, probe.id, {
      performedOn: today,
      performedBy: "Shift lead",
      method: "Ice point",
      referenceValue: "0",
      readingValue: "0.4",
      tolerance: "1",
      unit: "°C",
    });
    expect(pass).toMatchObject({
      result: "PASS",
      nextDueOn: addDays(today, 30),
      nonConformance: null,
    });
    let view = await getEquipment(ctx, probe.id);
    expect([view.calibrationDue, view.calibrationState]).toEqual([addDays(today, 30), "DUE_SOON"]);

    // Reads 1.6 → fail: out of service, HIGH NC (it serves a checkpoint) naming the doubtful period.
    const fail = await recordCalibration(staff, probe.id, {
      performedOn: today,
      performedBy: "Shift lead",
      referenceValue: "0",
      readingValue: "1.6",
      tolerance: "1",
      unit: "°C",
    });
    expect(fail.result).toBe("FAIL");
    const nc = await getDb().nonConformance.findUniqueOrThrow({
      where: { id: fail.nonConformance!.id },
    });
    expect([nc.severity, nc.source]).toEqual(["HIGH", "EQUIPMENT"]);
    expect(nc.description).toContain(`since the last passing calibration on ${today} are in doubt`);
    view = await getEquipment(ctx, probe.id);
    expect(view.equipment.status).toBe("OUT_OF_SERVICE");
    expect(view.calibrationState).toBe("NOT_PLANNED"); // a failed calibration sets no next date
    expect((await attentionItems(staff)).map((i) => i.key)).toContain("EQUIPMENT_OUT_OF_SERVICE");
    await expectRule(returnEquipmentToService(ctx, probe.id), "CALIBRATION_NEEDED");

    // Replaced battery, then a passing check returns it to service.
    await recordMaintenance(staff, probe.id, {
      type: "REPAIR",
      performedOn: today,
      performedBy: "Shift lead",
      description: "Battery replaced",
    });
    await recordCalibration(staff, probe.id, {
      performedOn: today,
      performedBy: "Shift lead",
      referenceValue: "0",
      readingValue: "-0.2",
      tolerance: "1",
    });
    view = await getEquipment(ctx, probe.id);
    expect(view.equipment.status).toBe("ACTIVE");
    expect(view.equipment.calibrations.map((c) => c.result)).toEqual(["PASS", "FAIL", "PASS"]);

    // Records are evidence; the database keeps them, results follow the numbers.
    await expect(
      getDb().calibration.update({ where: { id: pass.id }, data: { result: "FAIL" } }),
    ).rejects.toThrow();
    await expect(
      getDb().calibration.create({
        data: {
          organizationId: ctx.organizationId,
          equipmentId: probe.id,
          performedOn: new Date(),
          performedBy: "x",
          referenceValue: "0",
          readingValue: "5",
          tolerance: "1",
          result: "PASS",
          recordedByUserId: ctx.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it("plans maintenance, can be taken out of service and retired", async () => {
    const fridge = await createEquipment(ctx, {
      branchId: cairo,
      code: "FR-1",
      name: "Walk-in fridge",
      type: "FRIDGE",
      maintenanceIntervalDays: "90",
    });
    const m = await recordMaintenance(staff, fridge.id, {
      type: "PREVENTIVE",
      performedOn: today,
      performedBy: "Cool Tech Ltd",
      description: "Condenser cleaned, door seal checked",
    });
    expect(m.nextDueOn).toBe(addDays(today, 90));
    const listed = (await listEquipment(ctx)).find((e) => e.id === fridge.id)!;
    expect([listed.maintenanceState, listed.calibrationState]).toEqual(["OK", "NOT_PLANNED"]);

    await expectAppError(
      setEquipmentOutOfService(staff, fridge.id, { reason: "" }),
      "VALIDATION_FAILED",
    );
    await setEquipmentOutOfService(staff, fridge.id, { reason: "Compressor noise" });
    await expectAppError(returnEquipmentToService(staff, fridge.id), "FORBIDDEN");
    await returnEquipmentToService(ctx, fridge.id);
    await retireEquipment(ctx, fridge.id, { reason: "Replaced" });
    await expectRule(
      recordMaintenance(staff, fridge.id, {
        type: "CLEANING",
        performedOn: today,
        performedBy: "x",
        description: "x",
      }),
      "EQUIPMENT_RETIRED",
    );
    expect((await listEquipment(ctx)).map((e) => e.id)).not.toContain(fridge.id);
    expect((await listEquipment(ctx, { includeRetired: true })).map((e) => e.id)).toContain(
      fridge.id,
    );

    const { ctx: other } = await createTenant("equipment-other");
    await expectAppError(getEquipment(other, fridge.id), "NOT_FOUND");
    const cashier = await addMember(ctx, "cashier");
    await expectAppError(listEquipment(cashier.ctx), "FORBIDDEN");
  });
});
