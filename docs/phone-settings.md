# Phone settings tool (read-only, version 1)

The **Phone settings** pop-up in TPS Assistant shows TPS admins where calls go right now. It opens from the `/phone` command, or from a `tps_phone_open` button (to be added to the Admin tools menu). `/admin` itself stays with the Latenode admin menu and is not changed.

The pop-up shows:

- **On call:** who the Google "On call" calendar says is on call, who Phone.com's "On Call Plumber" menu actually sends unanswered calls to, and whether the two match. It also lists the next few shifts.
- **Office numbers:** each Phone.com number, its route, and that route's rules (for example "During Business Hours: ring ext 507, then Otherwise: menu On Call Plumber").

It runs here on Render inside the TPS Assistant gateway (`/slack/assistant-events`), so it uses no Latenode runs. It only *reads* Phone.com: the client has no write calls yet. The old **Calendar-Oncall Routing** Latenode scenario keeps doing the switching until the calendar-driven version replaces it.

## Setup (Paul)

Add three values in Render → tps-job-board → Environment. Don't paste them into chat or commit them.

1. `PHONECOM_API_TOKEN`: a Phone.com API token. You can use the same token Latenode already uses (its `PhoneAPI` global variable), or make a new permanent token in Phone.com's API Client tool (https://api-client.cit-phone.com).
2. `ONCALL_CALENDAR_ICS_URL`: Google Calendar → Settings → **On call** → Integrate calendar → **Secret address in iCal format**.
3. `TPS_ASSISTANT_BOT_TOKEN`: api.slack.com/apps → **TPS Assistant** → OAuth & Permissions → **Bot User OAuth Token** (`xoxb-…`). The pop-up has to be opened by the same app that received the click.

In api.slack.com/apps → TPS Assistant → **Slash Commands**, create `/phone` with the Request URL `https://tps-job-board.onrender.com/slack/assistant-events`. Leave `/admin` as it is.

Then save (Render redeploys), and check that https://tps-job-board.onrender.com/phone/health shows `"phonecom":true,"calendar":true,"popup":true`. Finally, type `/phone` in Slack.

If the Phone.com or calendar value is missing, the pop-up still opens and says which one isn't set.

## Notes

- Admins only (Paul, Edgar, Thayned), checked against the TPS workspace. Others get a lock notice.
- Results are cached for 60 seconds. The Refresh button rereads after 15 seconds. This keeps the tool well under Phone.com's limit of 30 calls per endpoint every 30 seconds.
- Shift times are read as Pacific office time. The calendar's events are labeled America/Vancouver/Tijuana, and British Columbia stays on daylight time from November 2026, so its clock no longer matches Oregon's.
- `src/phonecom.js` is the shared Phone.com connection that the texting tools will reuse once the SMS campaign is approved.

## On-call sync (`src/oncall-sync.js`)

Every 5 minutes Render compares the On call calendar with the Phone.com **On Call Plumber** menu's no-answer option. The mode is set by `PHONECOM_SYNC_MODE`:

- `report` (default): if the two disagree on two checks in a row, TPS Bot posts once in the channel the old scenario uses (C086PAU2BM5) to say what it *would* switch. Phone.com is not changed.
- `live`: switches the menu to the person on the calendar, reads it back to confirm, and posts the change. **Turn off the Latenode Calendar-Oncall Routing scenario at the same moment. Never run both.**
- `off`: does nothing.

When the calendar is unclear (nobody on call, two people at once, or a title with no TPS plumber name in it), Phone.com is left alone and the sync posts why, once. `/phone/health` shows the mode and the last check.
