import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  businessRuleViolation,
  forbidden,
  notFound,
  toErrorBody,
  unauthenticated,
  validationFailed,
} from "./errors";

describe("AppError mapping", () => {
  it("maps codes to HTTP statuses", () => {
    expect(unauthenticated().httpStatus).toBe(401);
    expect(forbidden().httpStatus).toBe(403);
    expect(notFound("Warehouse").httpStatus).toBe(404);
    expect(businessRuleViolation("NEGATIVE_STOCK", "Insufficient stock").httpStatus).toBe(422);
  });

  it("carries field issues for validation errors", () => {
    const result = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    expect(result.success).toBe(false);
    const error = validationFailed(result.error!);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toEqual({ issues: [{ path: "name", message: expect.any(String) }] });
  });

  it("serializes AppErrors with their code and message", () => {
    const { status, body } = toErrorBody(notFound("Product"));
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND", message: "Product not found" });
  });

  it("never leaks internals of unknown errors", () => {
    const { status, body } = toErrorBody(new Error("connect ECONNREFUSED db.internal:5432"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "An unexpected error occurred" } });
    expect(JSON.stringify(body)).not.toContain("db.internal");
  });

  it("is an Error subclass", () => {
    expect(new AppError("CONFLICT", "x")).toBeInstanceOf(Error);
  });
});
