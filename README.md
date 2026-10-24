# TPS Job Board

A Slack app that shows every TPS job in one place:

- **Home tab**: click *TPS Job Board* in the Slack sidebar. Tabs for My jobs, Today, Tomorrow, This week, All open and Done, plus a tech filter.
- **`/jobs`** in any channel opens the board; `/jobs 132174` opens one job; `/jobs eduardo` filters to a tech; `/jobs mine` shows your own jobs.
- **⚡ Shortcut** "Open job board" from the shortcuts menu.

Each card shows the job #, client, address, issue, status, time and tech, with buttons for the Slack thread, Work Order Files, Google Maps and the calendar.

**My jobs** is where a tech's board opens: their open jobs (booked times first) plus whatever they finished today. Once a job is in a tech's channel, its card has **📸 Add photos/notes**, a pop-up that sends photos, videos and notes into that call's thread in the tech's channel, so Call Route copies them along with the call.

## Where the data comes from

| Data | Source |
| --- | --- |
| Job details (client, address, issue, Drive folder) | PaulLatenode intake post in #incoming-calls, or the calendar event description |
| Appointment time | The job's latest post in #future-calls ("The call is Scheduled for…"), then a "Rescheduled:…" reply in the thread, then the TPS Jobs calendar |
| Tech | The job's row in the **Calls** Slack list (Assignee, once Assigned is checked), else the "Call assigned to *Name*" reply in the thread |
| Done | The **Completed** checkbox on the Calls list row (not the to-do checkbox), else a "Call completed" reply in the thread |

Today shows only that day's jobs: ones booked for today and new calls that came in today. Completed jobs stay on Today with a ✅ and drop off the next day. Open calls from the last 7 days are under *All open*. Only rescheduled jobs show a clock time, since intake calendar times are just when the call arrived. If the thread and calendar disagree on the day, the card shows a ⚠️ warning.

The app never edits the calendar, the Calls list or anyone's posts. The only thing it writes is a tech's photos and notes, as replies in the call's thread in their channel. Data refreshes every 2 minutes.

## Setup

1. **Calendar link.** Google Calendar → Settings → *TPS Jobs* → Integrate calendar → copy **Secret address in iCal format**.
2. **Slack app.** api.slack.com/apps → Create New App → From a manifest → TPS workspace → paste `manifest.yml`. Install it, then copy the **Bot User OAuth Token** (`xoxb-…`) and, under Basic Information, the **Signing Secret**.
3. **Render.** New → Blueprint → pick this repo. Fill in `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `CALENDAR_ICS_URL`.
4. **Check the URL.** The manifest assumes Render serves the app at `tps-job-board.onrender.com`. If Render picks a different URL, change the three URLs in the app's manifest in Slack to match.
5. **Invite the bot** to #incoming-calls and #future-calls: `/invite @TPS Job Board` in each. It joins public tech channels by itself when a tech sends photos; invite it to any private tech channel.
6. **After a scope change** (`files:read`, `files:write`, `channels:join` were added for photos), update the scopes from `manifest.yml` and click *Reinstall to Workspace*. The token stays the same.

## Development

```
npm install
npm test
node scripts/preview.js   # prints a Block Kit Builder link with sample jobs
```
