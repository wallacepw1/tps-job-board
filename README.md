# TPS Job Board

A Slack app that shows every TPS job in one place:

- **Home tab**: click *TPS Job Board* in the Slack sidebar. Tabs for My jobs, Today, Tomorrow, This week, All open and Done, plus a tech filter.
- **`/jobs`** in any channel opens the board; `/jobs 132174` opens one job; `/jobs eduardo` filters to a tech; `/jobs mine` shows your own jobs.
- **⚡ Shortcut** "Open job board" from the shortcuts menu.

Each card shows the job #, client, address, issue, status, time and tech. Unassigned cards offer Thread, Files, Map, Assign and Reschedule. Assigned cards add Tech chat, Add videos/notes, Reassign, Reschedule and Add helper. Done cards offer Thread, Files and Completed. Assignment-changing controls are restricted to admins.

**My jobs** is where a tech's board opens. Once a job is in a tech's channel, **Add videos/notes** sends photos, videos and notes into the lead call's thread, so they stay with the same call history.

## Where the data comes from

| Data | Source |
| --- | --- |
| Job details (client, address, issue, Drive folder) | PaulLatenode intake post in #incoming-calls, or the calendar event description |
| Appointment time | The job's latest post in #future-calls ("The call is Scheduled for…"), then a "Rescheduled:…" reply in the thread, then the TPS Jobs calendar |
| Current stage and lead | Current live Please Assign, Future, plumber and Completed cards, joined with the Calls row and Incoming history |
| Done | Current Completed card or verified completion history; later rescheduling or a return visit reopens the call |

Today shows current unassigned calls, today's scheduled calls, and visits assigned for today. Assigned calls remain Assigned even when they have an appointment. Media plus work comments without Complete gives Pending completion. Done calls appear below active work. A separate Yesterday stuck section keeps yesterday's unfinished visits visible for one day; older stuck visits stay in the history and morning report. Undated Future calls stay in All open and do not appear on Today.

Admins can assign, reassign, reschedule and add a helper. Reassignment preserves the visit date and history. Reschedule clears the plumber and moves the call to Future with a date/time or No date/time. A helper receives a link to the lead call and contributes directly to that thread. Older helper copies retain their archive protections. The authenticated worker verifies each change through Call Route. Data refreshes every two minutes and after workflow activity.

Assignment setup and recovery are described in [the deployment guide](docs/assignment-deployment.md). Until the worker and secrets are configured, assignment requests fail visibly without changing a call.

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
