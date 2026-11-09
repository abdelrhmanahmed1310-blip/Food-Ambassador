# Nutrition engine — operations guide

How to connect USDA FoodData Central, keep the library current, import the
bulk downloads, and what to do when something goes wrong. Rules and design:
[DECISIONS.md ADR-132](../DECISIONS.md); tables:
[DATA_MODEL.md §7](../DATA_MODEL.md).

## 1. Connect USDA FoodData Central

1. Request a free key at <https://fdc.nal.usda.gov/api-key-signup> (issued
   by api.data.gov; the default limit is 1,000 requests per hour per key).
2. Set it on the server as `USDA_FDC_API_KEY`:
   - **Render**: Dashboard → the web service → Environment →
     `USDA_FDC_API_KEY` (declared in `render.yaml` with `sync: false`, so
     the value is only ever entered in the dashboard) → Save. The service
     restarts with the key.
   - **Docker / other hosts**: add it to the environment of the app
     container, next to `DATABASE_URL`. Never commit it, never put it in a
     `NEXT_PUBLIC_*` variable.
3. Optional settings:
   - `USDA_FDC_REQUESTS_PER_HOUR` (default `1000`): the hourly budget,
     shared by all instances through the database rate limiter. Lower it
     if the key is shared with other systems.
   - `USDA_FDC_BASE_URL` (default `https://api.nal.usda.gov/fdc/v1`).
4. The server must reach `api.nal.usda.gov` over HTTPS (port 443). Allow
   it in any outbound firewall or proxy.
5. Check: Nutrition → USDA shows "Connected"; or call
   `GET /api/v1/nutrition/health` with a `nutrition:read` key —
   `usda.configured: true, usda.ok: true`.

The key is sent only in the `X-Api-Key` header from the server. It never
reaches browsers, the REST API's responses or the logs.

## 1a. Open Food Facts (barcode lookup)

No key is needed. When a barcode searched on Nutrition → Foods is not in
the library, the server asks `world.openfoodfacts.org` and shows a preview
that can be imported as an unverified record.

- Switch it off with `OPEN_FOOD_FACTS_LOOKUP=0`.
- Budget: `OPEN_FOOD_FACTS_REQUESTS_PER_MINUTE` (default 60; Open Food
  Facts asks for at most 100 product reads per minute).
- The server must reach `world.openfoodfacts.org` on port 443.
- The data is crowd-sourced (ODbL): check it against the packaging before
  verifying.

## 2. Day to day

| Task                                    | Where                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Find a food (library and USDA together) | Nutrition → Foods; mode HYBRID                                                    |
| Bring a USDA food into the library      | Foods → a USDA result → Import; or USDA → Import by FDC id                        |
| Enter a food from a label               | Foods → New food (empty = unknown, `NA` = not applicable)                         |
| Check and verify a food                 | Food profile → Mark verified (records who and when)                               |
| Use a food for a product                | Food profile → Link to a product… (never replaces a specification or lab profile) |
| See a recipe's full panel               | Recipe → Nutrition → Full nutrient panel                                          |
| Review findings                         | Nutrition → Data quality → close as resolved or ignored, with a note              |

## 3. Keeping the library current

- **Refresh policy** (Nutrition → USDA, organization-wide nutrition
  managers): a USDA record is stale after `refresh days` (default 90).
  With "Refresh stale USDA records every night" on, the job runner queues
  a REFRESH every night and a RELEASE_CHECK every Monday.
- **By hand**: "Refresh stale records now", "Check for new USDA releases",
  or Refresh on one food.
- A refresh that finds the same content changes nothing. Changed content
  is kept as a new source version. A verified record goes back to
  awaiting verification, with a "Changed after verification" finding.
- Jobs run as the person who asked for them. They stop if that person
  loses `nutrition.manage`.

## 4. Bulk downloads

For whole datasets, use the downloads at
<https://fdc.nal.usda.gov/download-datasets> (JSON). The files are large;
import them on the server, not through the browser:

```bash
pnpm nutrition:import-usda --org <organization-slug> --user <manager-email> \
  FoodData_Central_foundation_food_json_2025-04-24.json
```

- The command reads the file as a stream, in the wrapped USDA format, as a
  bare array, or as JSON Lines. It stores 200 records per transaction; if
  a chunk fails, it retries those records one by one.
- Progress is checkpointed. Running the same command again after an
  interruption continues from the last checkpoint.
- The run is listed under Nutrition → USDA → Jobs as "Bulk file".
- Recommended order: Foundation and SR Legacy first (generic foods), then
  FNDDS, then Branded (very large; import only if you need branded
  products).

## 5. Troubleshooting

| Symptom                                                    | Cause and fix                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Live USDA FoodData Central is not connected"              | `USDA_FDC_API_KEY` is not set, or the service was not restarted after setting it.                                                                                                          |
| Search shows "USDA FoodData Central did not answer"        | USDA or the network is down, or the 15 s timeout was reached after 3 attempts. Library results still show. Check `GET /api/v1/nutrition/health` and outbound access to `api.nal.usda.gov`. |
| "The hourly USDA request budget is used up"                | Over `USDA_FDC_REQUESTS_PER_HOUR`. Wait for the hour to roll over. Searches are cached for 10 minutes; use bulk files for large imports.                                                   |
| USDA answers 401/403 (shown as not connected)              | The key is wrong, revoked or not yet active. Request a new one and update the environment.                                                                                                 |
| A sync job is FAILED or PARTIAL                            | Open its errors on Nutrition → USDA → Jobs, fix the cause, then Retry. It continues from its checkpoint.                                                                                   |
| "This food has no serving with both grams and millilitres" | Volume cannot be converted without the food's own density. Add a serving with both values, from a label or measurement.                                                                    |
| A recipe total says "Incomplete"                           | At least one ingredient has no value for that nutrient. The figure in brackets is what is known. Link a library food or record a profile for the missing ingredient.                       |
| Bulk import stopped half way                               | Run the same command again; it resumes. Records that failed are listed in the job's errors.                                                                                                |

## 6. Verification status in this build

- Unit and integration tests cover the USDA client with a stand-in
  transport, following FoodData Central's published payload shapes: the
  header, retries, backoff, Retry-After, the hourly budget, import,
  refresh, versions, sync jobs and resume.
- A live call to USDA was **not** made from the build environment: its
  network policy does not allow the USDA hosts. Run step 1.5 after setting
  the key on the server to confirm the live connection.
