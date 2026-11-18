# Phone settings tool

The **Phone settings** pop-up in TPS Assistant shows TPS admins where calls go right now. It opens from the `/phone` command, or from a `tps_phone_open` button (to be added to the Admin tools menu). `/admin` itself stays with the Latenode admin menu and is not changed.

The pop-up shows:

- **On call:** who the Google "On call" calendar says is on call, who Phone.com's "On Call Plumber" menu actually sends unanswered calls to, and whether the two match. It also lists the next few shifts.
- **Office numbers:** each Phone.com number, its route, and that route's rules (for example "During Business Hours: ring ext 507, then Otherwise: menu On Call Plumber").

- **Office phones:** normal, 🎉 holiday mode, or 🏖️ Paul off (Edgar or Thayned answers), plus upcoming swaps, holidays and days off.
- Buttons: **🔁 Swap on call**, **🎉 Holiday**, **🏖️ Paul day off** (see below).

It runs here on Render inside the TPS Assistant gateway (`/slack/assistant-events`), so it uses no Latenode runs. The Latenode **Calendar-Oncall Routing** scenario is off; the on-call sync below replaced it.

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

## Swaps, holidays and Paul's days off (the calendar decides)

Everything is driven by events on the Google **On call** calendar, so they can be added from the pop-up or straight in Google Calendar:

| Event title (examples) | What the phones do |
|---|---|
| `Cindy On Call (swap)`, 8 AM to 8 AM | A one-off event beats the weekly shift underneath it: Cindy gets the on-call calls for that time. |
| `Holiday` / `Office closed` (all day) | **Holiday mode**: office numbers skip office hours and go straight to the On Call Plumber menu all day. |
| `Paul off: Edgar answers` / `Paul off: Thayned answers` (all day) | During office hours, calls that would ring Paul (ext 517) ring Edgar or Thayned instead. |

How the office numbers are switched: the tool never edits the office's own routes. For a mode it keeps a copy route named like `TPS holiday · normal route #123` (route 123 with the change) and points the office number at it. The number goes back to route 123 when the event ends. Only numbers whose route has an office-hours schedule rule plus an after-hours rule (holiday) or rings Paul's extension in office hours (day off) are touched. The texting line is left alone.

Changes follow the same `PHONECOM_SYNC_MODE` as the on-call menu (report = post what would change; live = switch and post in #office). A change made from the pop-up is applied at once; one made in Google Calendar is applied within 5 to 10 minutes.

### Setup: let the buttons write to the calendar (Paul, about 5 minutes)

Render can only read the calendar, so the buttons write through a small Google Apps Script that runs as you. Until this is done, the buttons still work but tell you which event to add yourself.

1. Signed in to Google as the owner of the On call calendar, go to https://script.google.com and click **New project**. Name it `TPS On call writer`.
2. Delete what's in the editor and paste all of `docs/oncall-calendar-script.gs`. Click 💾 Save.
3. ⚙️ **Project Settings**: set **Time zone** to `(GMT-08:00) Pacific Time - Los Angeles`. Under **Script Properties**, add property `KEY` with a long password you make up (letters and numbers). Save.
4. Back in the editor, pick `testSetup` in the function drop-down and click **Run**. Approve the Google permission prompts (Advanced → Go to TPS On call writer). The log should show the calendar's name.
5. **Deploy → New deployment** → type **Web app**. Execute as **Me**, Who has access **Anyone**. Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
6. In Render → tps-job-board → Environment add `ONCALL_CALENDAR_SCRIPT_URL` = that URL and `ONCALL_CALENDAR_SCRIPT_KEY` = the same password as step 3. Save (Render redeploys).
7. Check https://tps-job-board.onrender.com/phone/health shows `"calendarWrite":true`.

The script can only add events and remove events that the phone tool added (their description says "Added from TPS Assistant"). Anyone without the password gets "wrong key".
