# Delivery platform orders

How orders from delivery platforms (HungerStation, Jahez, Keeta, or any
platform with the same concept) reach the point of sale. Rules:
DECISIONS.md ADR-069. Signing and secrets work as for every inbound
connector (docs/INTEGRATIONS.md, ADR-048).

## How a platform connects

Each platform plugs in through an **adapter** (`src/modules/delivery/adapters.ts`)
that turns what the platform sends into the canonical events below.

| Platform      | Today                                                         | Native adapter needs                                                                          |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| HungerStation | Canonical format (directly or through integration middleware) | Partner API specification and sandbox from the HungerStation / Delivery Hero integration team |
| Jahez         | Canonical format                                              | API key and documentation from integration@jahez.net                                          |
| Keeta         | Canonical format                                              | Keeta Open Delivery API credentials (issued after an NDA)                                     |
| Other         | Canonical format                                              | —                                                                                             |

No native adapter is marked available until it has been tested against the
platform's own API. Many restaurants already receive platform orders through
middleware (aggregators); such middleware can send the canonical format
today.

Adding a native adapter: implement `parse` (and any platform-specific
signature check) for that platform, test it against the platform's sandbox,
then set `native: true`. Nothing else changes — mapping, acceptance,
kitchen, stock, VAT and ZATCA are shared.

## Setting up (POS → Delivery orders → Set up platforms)

1. **Connect a platform:** a name, the platform, and the register whose open
   shift records the orders. Optionally accept orders automatically when
   every item is mapped and a shift is open. The address and signing secret
   are shown once (rotate the secret from the connector's page).
2. **Map the items:** each platform item id → a menu item; each modifier id →
   a modifier option. Ids seen on orders waiting for a mapping are listed.

The person who creates the connector must be able to sell at that register:
orders are recorded under their access.

## Request

`POST /api/integrations/inbound/<publicId>`, `Content-Type: application/json`,
signed and idempotent as every inbound request:

| Header            | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| `X-FA-Timestamp`  | Unix seconds; refused when more than 5 minutes off      |
| `X-FA-Signature`  | `sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` |
| `Idempotency-Key` | 8–120 characters `[A-Za-z0-9_.:-]`, unique per event    |

### `order.placed`

```json
{
  "event": "order.placed",
  "order": {
    "id": "HS-100231",
    "displayCode": "#231",
    "placedAt": "2026-11-01T13:05:00+03:00",
    "customerName": "Sara",
    "note": "No onions please",
    "items": [
      {
        "externalId": "BURGER-01",
        "name": "Classic burger",
        "quantity": 2,
        "unitPrice": "28.00",
        "modifiers": [{ "externalId": "CHEESE", "name": "Extra cheese" }]
      }
    ],
    "discount": "5.00",
    "total": "51.00"
  }
}
```

- Amounts are strings in the organization's base currency, **VAT included**,
  as the guest paid. `unitPrice` is per unit with its modifiers.
- `discount` is the discount the restaurant funds; `total` = items − discount
  (the delivery fee is the platform's and is not sent). An order whose total
  does not match its items is kept with the reason and not recorded.
- Only a first name or label is kept (`customerName`); send no phone numbers
  or addresses.
- The platform's order `id` is unique per connector: the same order sent
  again is answered as a duplicate.

### `order.cancelled`

```json
{ "event": "order.cancelled", "order": { "id": "HS-100231", "reason": "Customer cancelled" } }
```

A waiting order is closed. An accepted order is voided when its shift is
still open (stock returns, a ZATCA credit note is issued); otherwise it is
marked for a manager to refund.

## Responses

| Status | Body                                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| 200    | `{ "deliveryOrderId", "status" }` (+ `"problem"` if auto-accept could not record it) |
| 200    | `{ "duplicate": true, … }` for a repeated order or key                               |
| 400    | `invalidBody` / `idempotencyKeyRequired`                                             |
| 401    | `invalidSignature`                                                                   |
| 403    | `connectorDisabled` / `creatorNoAccess`                                              |
| 404    | `notFound` (address) / `orderNotFound` (cancel)                                      |
| 429    | `rateLimited`                                                                        |

## What an accepted order becomes

A POS order on the connector's register: channel DELIVERY, the platform's
prices (our promotions do not apply), the restaurant-funded discount as the
order discount, one payment "delivery platform" with the reference
`<platform>:<order id>`, a kitchen ticket labelled with the platform and its
code, stock used through recipes, VAT and the ZATCA simplified invoice as any
order. The shift report shows money owed by the platforms apart from cash and
card. Telling the platform the order was accepted or is ready goes through
the platform's own API once its native adapter exists (or the middleware).
