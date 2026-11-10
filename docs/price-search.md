# Price search (TPS Assistant)

Read-only supplier comparison for TPS admins. It does not order parts, schedule a branch transfer, or record installer or Edgar approval.

## Where it lives

TPS Assistant and TPS Job Board are different Slack apps.

| App | What this repo does |
| --- | --- |
| Job Board | `src/app.js` publishes that app's Home with `SLACK_BOT_TOKEN`. Price search is not on that Home. |
| Assistant | Slack posts events to `POST /slack/assistant-events`, verified with `TPS_ASSISTANT_SIGNING_SECRET`. Phone settings and this price search answer here. `app_home_opened` for the Assistant Home tab is still forwarded on, because this process does not build that Home. Publishing a new Home from here would replace it. |

## Home button contract

This app does not publish the Assistant Home. The service that already receives Assistant `app_home_opened` should add one button to the existing Home blocks. Do not replace that Home.

The button is a `block_actions` element. The Home view does not need a `callback_id` for this click. The gateway reads `action_id` only.

```json
{
  "type": "button",
  "action_id": "tps_price_search_open",
  "text": { "type": "plain_text", "text": "Search prices" },
  "value": "open"
}
```

`value` is `open`. A missing value still opens the search when the action id matches. `appendPriceSearchHomeButton(view, true)` inserts that button in its own actions block, `tps_price_search_entry`, after the first header and keeps every existing block.

The gateway then creates the modals. The Home publisher does not send these callback ids:

- `tps_price_search_form` on submit
- `tps_price_search_results` while results are open, including close

A click is handled only when all of these are true:

- `PRICE_SEARCH_ENABLED` is exactly `1`. Any other value, including unset, leaves the click on the existing Assistant event path.
- `team.id` is `T086X85G14N`.
- `user.id` is `U0876C3TEGL`, `U0C2PMHJK0A`, or `U0C2X3HU490`.

Other people in that workspace get an empty acknowledgement and no modal. The modal itself is opened with `TPS_ASSISTANT_BOT_TOKEN`.

## Configuration

Leave these empty until a real identify endpoint and bridge token exist. There is no default host.

| Variable | Purpose |
| --- | --- |
| `PRICE_SEARCH_ENABLED` | `1` turns the modal and the worker bridge on. Otherwise both stay off. |
| `PRICE_SEARCH_IDENTIFY_URL` | https identify endpoint. Loopback and localhost are refused. |
| `PRICE_SEARCH_IDENTIFY_TOKEN` | Bearer token for that endpoint. Server only. |
| `TPS_PRICE_BRIDGE_TOKEN` | Bearer token the Mac worker sends to this app. Server only. |
| `TPS_PRICE_COLLECT_MODE` | `execute` asks the worker to collect. Any other value, including unset, queues `plan`. |
| `TPS_ASSISTANT_BOT_TOKEN` | Already used by Phone settings. Opens the modal. |

`GET /slack/assistant-events/health` adds `priceSearch.enabled`, `priceSearch.identifyConfigured`, `priceSearch.bridgeConfigured`, and `priceSearch.assistantToken`. Those are booleans. URLs and tokens are not included.

## Collector request

The Mac calls `POST /internal/tps-pricing/claim` and `POST /internal/tps-pricing/jobs/{id}/result` on this app. Claim returns `{ "job": null }` or `{ "job": { "id", "leaseId", "request" } }`. A result post of `{ "workerId", "leaseId", "result" }` returns `{ "accepted": true }`. The lease lasts 3 minutes. A matching result can be posted again. A different result for the same lease is refused. An expired lease is refused and the job is not left running. A restart drops an in-progress lease back to the queue.

`request` is validated against `src/contracts/collector-tps-price-v1.schema.json`. `result.priceKind` is only `verified_account_net`, `authenticated_unknown`, `public`, `list`, `unknown`, `not_configured`, or `unsupported`. `collector.httpEndpoint` must be null or the result is refused. `approvals.autoPurchase` must be false.

A price or an exact/equivalent label is shown only on a candidate whose own `evidenceKind` is `live_dom`, and only when that job has `collector.linked`, `collector.liveRun`, and a null `collector.httpEndpoint`. `collector.liveRun` does not make a fixture, saved observation, or hypothesis card live. `priceRow` has no evidence field, so a row is shown under the live page for its supplier and withheld everywhere else. WinSupply, SupplyHouse, and MBM show a signed-in amount only when `priceKind` is `authenticated_unknown` on that live page, labeled "Signed-in price; net status unverified." That label is not changed to `verified_account_net`. `public` and `list` amounts for those three are not shown. `companyContext.winsupply` is `WinSupply of South San Diego (National City)`. Heater searches omit SupplyHouse and MBM. WinSupply stays included.

Identification, when configured, is mapped into `identifiedSpecs` and `candidateHints` with nulls preserved. The full enrichment stays beside the queued request and is not part of the claim body. With no identify URL, the modal says identification is not connected and does not invent specs. A photo without that URL is not queued.
