# TPS Job Board

A read-only Slack app that shows every TPS job in one place:

- **Home tab**: click *TPS Job Board* in the Slack sidebar. Tabs for Today, Tomorrow, This week, Needs scheduling and Done, plus a tech filter.
- **`/jobs`** in any channel opens the board; `/jobs 132174` opens one job; `/jobs eduardo` filters to a tech.
- **⚡ Shortcut** "Open job board" from the shortcuts menu.

Each card shows the job #, client, address, issue, status, time and tech, with buttons for the Slack thread, Work Order Files, Google Maps and the calendar.

## Where the data comes from

| Data | Source |
| --- | --- |
| Job details (client, address, issue, Drive folder) | PaulLatenode intake post in #incoming-calls, or the calendar event description |
| Appointment time | TPS Jobs Google Calendar, overridden by a "Scheduled for…" / "Rescheduled:…" reply in the thread |
| Tech | "Call assigned to *Name*" reply in the thread |
| Done | "Call completed" reply in the thread |

Calendar events that sit at the exact minute a call came in are intake placeholders, not appointments, so those jobs show under *Needs scheduling*. If the thread and calendar disagree on the day, the card shows a ⚠️ warning.

The app only reads. It never posts in channels or edits the calendar. Data refreshes every 2 minutes.

## Setup

1. **Calendar link.** Google Calendar → Settings → *TPS Jobs* → Integrate calendar → copy **Secret address in iCal format**.
2. **Slack app.** api.slack.com/apps → Create New App → From a manifest → TPS workspace → paste `manifest.yml`. Install it, then copy the **Bot User OAuth Token** (`xoxb-…`) and, under Basic Information, the **Signing Secret**.
3. **Render.** New → Blueprint → pick this repo. Fill in `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `CALENDAR_ICS_URL`.
4. **Point Slack at Render.** In `manifest.yml` replace `YOUR-APP-URL` with the Render URL (e.g. `tps-job-board.onrender.com`), and update the app's manifest in Slack.
5. **Invite the bot** to #incoming-calls: `/invite @TPS Job Board`.

## Development

```
npm install
npm test
node scripts/preview.js   # prints a Block Kit Builder link with sample jobs
```
