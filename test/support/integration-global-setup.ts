import "dotenv/config";
import { execFileSync } from "node:child_process";

// Apply pending migrations to the test database (non-destructive). Tests never
// assume an empty database: every test creates its own uniquely named data.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL must be set to run integration tests");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}
