# Industry starter rule packs

Pick the folder closest to your business, copy it to `/business/`, edit the
limits in each file's `policy:` block — you're live.

On first start, if `business/` doesn't exist yet, the server copies the pack
named by `STARTER_TEMPLATE` in `.env` (default `dental-office`) for you.

- `dental-office/` — **the demo business**: Harbor Smile Dental (fictional), ~10
  people. `company` (privacy, no clinical advice, emergencies, write-off cap),
  `front-desk` (appointment requests, cancellation-fee waivers) and `billing`
  (refunds, courtesy discounts, payment plans)

Planned packs:

- `coffee-shop/` — retail/food service
- `machine-shop/` — industrial job shop: work orders, quotes, lead times
- `engineering-firm/` — professional services: SOWs, hourly rates, scope rules

One codebase, any business — only the rules change.
