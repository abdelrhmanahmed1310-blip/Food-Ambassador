import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Optional here so `prisma generate` works without a database (e.g. in CI
    // lint jobs). Commands that touch the database fail clearly if it is unset.
    url: process.env["DATABASE_URL"],
  },
});
