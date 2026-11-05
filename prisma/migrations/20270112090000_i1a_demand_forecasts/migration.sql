-- I1a: demand forecasts and forecast-based replenishment (DECISIONS.md ADR-120).
-- Forecasts are worked out from the ledger when asked; only the two
-- settings that turn a forecast into an order are stored.

-- AlterTable
ALTER TABLE "procurement_settings" ADD COLUMN     "forecast_review_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "forecast_service_level" DECIMAL(3,2) NOT NULL DEFAULT 0.95;

ALTER TABLE "procurement_settings"
  ADD CONSTRAINT "procurement_settings_forecast_review_days_check"
    CHECK ("forecast_review_days" BETWEEN 1 AND 90),
  ADD CONSTRAINT "procurement_settings_forecast_service_level_check"
    CHECK ("forecast_service_level" IN (0.90, 0.95, 0.98, 0.99));
