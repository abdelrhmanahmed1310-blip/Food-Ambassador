# Integrations

Food Ambassador talks to other systems through **connectors** (Settings →
Integrations, owners and admins only, permission `integrations.manage`).
Rules: DECISIONS.md ADR-048.

Two kinds exist today, both in our own documented format. **No third-party
connector (a named POS, Xero, WhatsApp …) is provided or claimed** until it
has been tested against that provider's real sandbox.

| Kind                   | Direction | What it does                                                                          |
| ---------------------- | --------- | ------------------------------------------------------------------------------------- |
| Inbound sales webhook  | in        | A POS or middleware posts sales lines; they go through the normal sales import        |
| Outbound event webhook | out       | We POST signed events when a PO is approved, goods are received, an invoice is issued |

Each connector has a **signing secret** (`fa_whsec_…`), shown once when the
connector is created or the secret rotated. It is stored encrypted
(AES-256-GCM); only the last four characters are kept in clear. Lost it?
Rotate — the old one stops working at once.

## Signatures (both directions)

```
X-FA-Timestamp: <unix seconds>
X-FA-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

The signature covers the exact bytes of the body. Receivers must compare in
constant time and refuse timestamps more than 5 minutes from their clock —
we do the same for inbound requests.

## Inbound sales webhook

```
POST /api/integrations/inbound/<connector id>
Content-Type: application/json
Idempotency-Key: <8–120 chars: letters, digits, _ . : ->
X-FA-Timestamp / X-FA-Signature as above

{ "lines": [
  { "date": "2026-11-01", "external_id": "T-1001-1", "item_code": "SALAD",
    "item_type": "RECIPE", "quantity": "2", "net_amount": "90",
    "gross_amount": "103.50", "tax_code": "S", "channel": "dine-in" } ] }
```

Fields are those of the sales CSV import (sales page → template); up to
5,000 lines and 900 KB per request. Sales post into the connector's
warehouse, consuming stock through recipes, **as the person who created the
connector, with their current permissions** — if they lose access, the
connector stops working.

| Response | Meaning                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 200      | `{ importId, imported, skipped }`; a repeated Idempotency-Key returns the first result with `duplicate: true` |
| 400      | Missing/invalid Idempotency-Key, or the body is not the format above                                          |
| 401      | `invalidSignature` with `reason` MISSING, STALE or MISMATCH                                                   |
| 403      | Connector disabled, or its creator no longer has access                                                       |
| 404      | Unknown connector                                                                                             |
| 413      | Body over 900 KB                                                                                              |
| 422      | Lines refused by the sales import (`errors` lists line numbers and reasons); nothing was posted               |
| 429      | More than 120 requests per minute for this connector                                                          |

Ticket lines already imported (same `external_id`) are skipped even under a
new key, so a POS may safely resend. Every request except an unknown
connector is logged (status, outcome, body hash and size — not the body) and
visible on the connector page.

## Outbound event webhooks

Events: `purchase_order.approved`, `goods_receipt.posted`,
`sales_invoice.issued`. Headers: `X-FA-Event`, `X-FA-Event-Id` (stable per
event — deduplicate on it), timestamp and signature. Body:

```json
{
  "id": "purchase_order.approved:<uuid>",
  "type": "purchase_order.approved",
  "occurredAt": "2026-11-01T09:00:00.000Z",
  "data": {
    "orderId": "…",
    "number": "PO-2026-000012",
    "supplierId": "…",
    "warehouseId": "…",
    "total": "1250.00"
  }
}
```

Payloads carry identifiers, numbers and totals only — no personal data.
Any 2xx counts as delivered. Otherwise we retry after 1 min, 5 min, 30 min,
2 h and 12 h, then mark the delivery **failed**; it can be retried from the
connector page. Redirects are not followed; the timeout is 10 s.

The URL must be **https** to a public address. Addresses resolving to
loopback, private, link-local or carrier-grade NAT ranges are refused when
the connector is saved, and again on the IP actually dialled at send time
(protects against DNS rebinding). `INTEGRATIONS_ALLOW_PRIVATE_URLS=1`
lifts this for local development only.

### Running the sender

Events are written in the same transaction as the business change (an
outbox) and sent by a worker:

```bash
pnpm integrations:deliver            # one pass (e.g. from cron every minute)
pnpm integrations:deliver --watch    # loop every 30 s
```

Several workers may run: each due delivery is claimed with a 5-minute lease.
Without a worker running, events wait — nothing is lost.

## Secrets and keys

`INTEGRATION_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand
-base64 32`) encrypts connector secrets. If it is unset a key is derived
from `AUTH_SECRET`; set it explicitly in production so the two can be
rotated separately. Changing it makes existing secrets unreadable — rotate
every connector's secret afterwards.
