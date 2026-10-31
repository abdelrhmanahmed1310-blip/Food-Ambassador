# Pilot onboarding checklist

For setting up one pilot customer. Tick in order; each step names who does
it and how to check it. Nothing here creates demo data.

## Before the first visit

- [ ] Decisions the pilot depends on are made: hosting and data residency
      (Q-03), e-mail provider for invitations and resets (Q-10), whether
      2FA/SSO is required (Q-07), allergen/label rules for the market (Q-02),
      the customer's POS/accounting systems for import/export formats (Q-06).
- [ ] Instance deployed, `pnpm db:verify` green, backup scheduled and one
      restore drill done (docs/OPERATIONS.md).
- [ ] Owner account created by sign-up; base currency and time zone checked
      (the currency cannot change later, Q-11).

## Organization setup (owner or administrator)

- [ ] VAT: Settings → Tax → country preset; VAT registration and number if
      registered; prices incl./excl. VAT.
- [ ] Purchasing settings: approval limit, over-receipt and invoice price
      tolerance, account codes for the journal export.
- [ ] Branches and warehouses (and storage locations where useful).
- [ ] Members invited with roles and, for branch staff, branch scope. Check:
      a branch manager sees only their branch.

## Master data (procurement / kitchen)

- [ ] Units checked; product conversions for items bought in cases or
      counted in pieces (also needed for nutrition by weight).
- [ ] Products (CSV import), categories, barcodes.
- [ ] Suppliers with payment terms and supplier items with prices.
- [ ] Opening balances per warehouse (CSV), with lots and expiry dates;
      check: stock value on the valuation page equals the customer's figure.
- [ ] Reorder levels for key items.
- [ ] Recipes and sub-recipes with yields, waste and portions; selling
      prices and food cost targets.
- [ ] Nutrition and allergens from supplier specifications (or the
      ingredient library), verified by a second person; labels approved
      where needed.

## Daily operations to rehearse with the team

- [ ] Purchase order → approval → receipt (with a rejection and a lot) →
      supplier invoice match → payment.
- [ ] Transfer between warehouses; write-off with reason; stock count.
- [ ] Sales import from the POS export file; check cost of sales.
- [ ] Temperature records and a checklist; raise and close a
      non-conformance.
- [ ] Recall simulation on one lot.
- [ ] Reports: waste, food cost by branch; the "needs attention" list.

## Acceptance at the end of the pilot

- [ ] Stock value and quantities agree with a physical count within the
      agreed tolerance.
- [ ] Food cost % matches the customer's own calculation for one month.
- [ ] Every user can sign in, and nobody sees another branch's data they
      should not.
- [ ] Backup and restore drill repeated.
