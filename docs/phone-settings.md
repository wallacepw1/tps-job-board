# Phone settings tool (read-only, version 1)

`/admin phone` in TPS Assistant shows TPS admins where calls go right now:

- **On call:** who the Google "On call" calendar says is on call, who Phone.com's "On Call Plumber" menu actually sends unanswered calls to, and whether the two match. It also lists the next few shifts.
- **Office numbers:** each Phone.com number, its route, and that route's rules (for example "During Business Hours: ring ext 507, then Otherwise: menu On Call Plumber").

It runs here on Render inside the TPS Assistant gateway (`/slack/assistant-events`), so it uses no Latenode runs. It only *reads* Phone.com: the client has no write calls yet. The old **Calendar-Oncall Routing** Latenode scenario keeps doing the switching until the calendar-driven version replaces it.

## Setup (Paul)

Add two values in Render → tps-job-board → Environment. Don't paste them into chat or commit them.

1. `PHONECOM_API_TOKEN`: a Phone.com API token. You can use the same token Latenode already uses (its `PhoneAPI` global variable), or make a new permanent token in Phone.com's API Client tool (https://api-client.cit-phone.com).
2. `ONCALL_CALENDAR_ICS_URL`: Google Calendar → Settings → **On call** → Integrate calendar → **Secret address in iCal format**.

Then save (Render redeploys), and check that https://tps-job-board.onrender.com/phone/health shows `"phonecom":true,"calendar":true`. Finally, type `/admin phone` in Slack.

If either value is missing, `/admin phone` still opens and says which one isn't set.

## Notes

- Admins only (Paul, Edgar, Thayned), checked against the TPS workspace. Others get a lock notice.
- Results are cached for 60 seconds. The Refresh button rereads after 15 seconds. This keeps the tool well under Phone.com's limit of 30 calls per endpoint every 30 seconds.
- Shift times are read as Pacific office time. The calendar's events are labeled America/Vancouver/Tijuana, and British Columbia stays on daylight time from November 2026, so its clock no longer matches Oregon's.
- `src/phonecom.js` is the shared Phone.com connection that the texting tools will reuse once the SMS campaign is approved.
