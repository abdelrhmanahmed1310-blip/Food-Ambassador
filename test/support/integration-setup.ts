import "dotenv/config";

// Integration tests always run against TEST_DATABASE_URL, never the dev database.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run integration tests");
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl && process.env.CI !== "true") {
  // Allowed only in CI, where the database is a disposable service container.
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL outside CI");
}
process.env.DATABASE_URL = testUrl;
