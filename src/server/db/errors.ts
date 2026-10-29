/** Prisma error helpers that work without importing runtime classes. */
interface PrismaLikeError {
  code?: string;
  meta?: {
    target?: string | string[];
    driverAdapterError?: { cause?: { constraint?: { index?: string; fields?: string[] } } };
  };
}

function asPrismaError(error: unknown): PrismaLikeError | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error as PrismaLikeError)
    : undefined;
}

/** Name of the violated unique constraint/index, when the driver reports it. */
export function violatedConstraint(error: unknown): string | undefined {
  const meta = asPrismaError(error)?.meta;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  if (constraint?.index) return constraint.index;
  if (constraint?.fields) return constraint.fields.join(",");
  if (Array.isArray(meta?.target)) return meta.target.join(",");
  return meta?.target;
}

/**
 * Unique-constraint violation (P2002). With `constraintSuffix`, only matches
 * when the violated constraint's name ends with it, e.g. "_code_key".
 */
export function isUniqueViolation(error: unknown, constraintSuffix?: string): boolean {
  if (asPrismaError(error)?.code !== "P2002") return false;
  if (!constraintSuffix) return true;
  return violatedConstraint(error)?.endsWith(constraintSuffix) ?? false;
}
