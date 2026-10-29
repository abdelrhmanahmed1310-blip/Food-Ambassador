import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth/auth";

// Better Auth HTTP endpoints (rate limited; see src/server/auth/auth.ts).
export const { GET, POST } = toNextJsHandler((request: Request) => getAuth().handler(request));
