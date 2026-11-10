# Price search (TPS Assistant)

Read-only supplier comparison for TPS admins. It does not order parts, schedule a branch transfer, or record installer or Edgar approval.

## Where it lives

TPS Assistant and TPS Job Board are different Slack apps.

| App | What this repo does |
| --- | --- |
| Job Board | `src/app.js` publishes that app's Home with `SLACK_BOT_TOKEN`. Price search is not on that Home. |
| Assistant | Slack posts events to `POST /slack/assistant-events`, verified with `TPS_ASSISTANT_SIGNING_SECRET`. Phone settings and this price search answer here. `app_home_opened` for the Assistant Home tab is still forwarded on, because this process does not build that Home. Publishing a new Home from here would replace it. |

The Home button this modal expects:

- `action_id`: `tps_price_search_open`
- label: `Search prices`

`appendPriceSearchHomeButton(view, allowed)` inserts that button after the first header and leaves every existing block in place. Nothing in the running app calls it, so the current Assistant Home is unchanged until the service that already publishes that Home adds the button. With `PRICE_SEARCH_ENABLED` unset, a click with that action id keeps following the existing Assistant forward path.

Admins are the same three users as the other administrative tools (Paul, Edgar, Thayned), and the workspace must be the TPS workspace.

## Configuration

Set these on the Render service only after a verified backend URL and credential exist. Leave them empty until then. The modal then says price search is not connected and shows no prices.

| Variable | Purpose |
| --- | --- |
| `PRICE_SEARCH_ENABLED` | `1` turns the modal on. Any other value, including empty, leaves it off. |
| `PRICE_SEARCH_API_URL` | Full `https` URL of the price API. There is no default host. |
| `PRICE_SEARCH_API_TOKEN` | Bearer token. It stays on the server. It is not written into view metadata or logs. |
| `TPS_ASSISTANT_BOT_TOKEN` | Already used by Phone settings. The modal is opened with the Assistant bot. |

`GET /slack/assistant-events/health` adds `priceSearch.enabled`, `priceSearch.configured`, and `priceSearch.assistantToken`. Those are booleans. The URL and token are not included.

The photo, when the form includes one, is read with the Assistant token and sent as `photoRef`, `fileName`, and `fileContent`. `fileUrl` is not sent.

## Client contract (`tps-price-v1`)

This matches the current prose outline. It is not a formal JSON Schema. The collector may still return `price: null` with `priceKind: "collector_not_linked"`.

`POST` the configured URL, header `Authorization: Bearer <token>`, JSON body:

```json
{
  "contractVersion": "tps-price-v1",
  "requestId": "string",
  "queryType": "photo | model_text | part_number | description",
  "modelHint": "optional",
  "partNumber": "optional",
  "description": "optional",
  "photoRef": "optional Slack file id",
  "fileName": "optional",
  "fileContent": "optional base64",
  "categoryHint": "general | heater | backflow",
  "qty": 1,
  "matchPriority": "default | strict_size",
  "location": "optional ZIP, store, or branch",
  "suppliers": ["hirsch", "reece_us", "homedepot", "lowes", "supplyhouse", "masterbuildermercantile", "winsupply"],
  "uiSource": "tps_assistant_app_home"
}
```

Heater searches send Hirsch, Reece US, Home Depot, Lowe's, and WinSupply. SupplyHouse and MBM stay off heater searches. Backflow and general searches send all seven. `companyContext.winsupply` is `WinSupply of South San Diego (National City)`. WinSupply, SupplyHouse, and MBM need their own signed-in account prices. A guest price is never shown for those three.

The queued request uses `mode: "plan"` unless `TPS_PRICE_COLLECT_MODE=execute`. Identification runs only when `PRICE_SEARCH_IDENTIFY_URL` is an https endpoint that is not loopback. Until that is set, the modal says identification is not connected and does not invent specs. A full enrichment body is kept beside the queued request. The Mac claim receives only the collector request. AI specs and candidate hints are labeled unverified and are not treated as manufacturer evidence. Null spec fields stay null.

A finished body can be returned immediately. A pending body is `{ "status": "pending", "jobId": "job_1", "pollAfterMs": 1500 }`. The client then calls `GET <configured url>?jobId=job_1` with the same bearer token. Closing the modal cancels that wait. The job id may contain only letters, numbers, underscores, and hyphens.

Result fields the modal understands:

- `identify` for the category, specs, and unknowns
- `candidates[]` with `exact`, `candidate_equivalent`, or `unknown`, plus differences
- `priceRows[]` with `price` (`null` until a collector is linked), `priceKind`, `currency`, `uom`, `rawLabel`, `provenance`, `observedAt`, `factoryList`, `availability.local`, `availability.network`, `otherBranches`, `availableToOrder`, and `imageUrl`
- `uiHints` are informational. The modal always says installer approval is not granted and Edgar approval is still required.

`imageUrl` is shown only when it is an `https` URL on that result. Otherwise the card says no product image was supplied. A network count stays unconfirmed unless `availability.network.confirmed` is true. "Available to order" is not shown as stock. An unknown network is not shown as none.

The modal also refuses gallon-only overlap, electric or heat-pump equipment against gas, and a lower BTU class such as 75k or 76k against a commercial 120k or 125k request.
