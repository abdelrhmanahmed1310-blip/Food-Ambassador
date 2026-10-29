import "server-only";
import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";

/** In pages, render the 404 page for NOT_FOUND (incl. other tenants' IDs) instead of an error. */
export async function notFoundOnAppError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof AppError && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN"))
      notFound();
    throw error;
  }
}
