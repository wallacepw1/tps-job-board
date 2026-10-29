# Assignment deployment and recovery

The board verifies Slack requests with its existing signing secret. Operational TPS Bot channel interactions use a separate raw-body signature bridge. Latenode never trusts a public request's user ID without a verified bridge or private server key.

## Configure

Set these Render environment values without committing or sharing secret values:

- `TPS_CALL_ACTIONS_URL`: the TPS Call Assignments production webhook URL.
- `TPS_INTERNAL_KEY`: the matching existing Latenode global.
- `TPS_CALL_ROUTE_SIGNING_SECRET`: the operational TPS Bot signing secret, separate from the board signing secret and bot token.

Configure TPS Call Assignments with the stored Lists and Paul Userbot connections. Save Sequential processing, then set `TPS_ASSIGNMENT_SEQUENTIAL_READY=true`. Set `TPS_ASSIGNMENT_HOOK` to its production URL. Keep `TPS_ASSIGNMENT_ENABLED=false` until both app deployments and validation are complete.

Deploy the reviewed Job Board branch, verify `/healthz`, and configure TPS Bot Interactivity to `https://tps-job-board.onrender.com/slack/call-actions`. Keep Job Board's own Slack event/interactivity endpoint unchanged. Subscribe the Job Board app to `message.channels` and invite it to the plumber channels for delayed helper contributions.

Deploy the paired Call Route reader and updated plumber-card menu templates. Existing eligible cards need their menu updated as well. Preserve completed and closing return-visit routing. Enable the shared feature flag only after this configuration is verified.

## Recovery

Each action has a durable request ID, actor, expected lead and helper. An uncertain dispatch must be reconciled rather than submitted under a new ID. The original admin can reopen its Job Board assignment form to check and resume the pending request. Another admin cannot take over its identity.

Helper cleanup removes child messages before the card, only after their current revisions are verified in Incoming. Shared files are retained. A durable deletion marker allows a lost parent-delete response to reconcile an already missing card. New or edited replies stop cleanup until archived. Retained helper-thread mappings preserve delayed events in Incoming after retirement.

An uncertain file upload retains its source and reservation for inspection; do not clear receipts and blindly upload another copy. No deployment fixture should dispatch a real customer call or WhatsApp message.

## Rollback

Disable `TPS_ASSIGNMENT_ENABLED` first and stop new requests. Reconcile any active helper/request state before reverting Call Route or removing the bridge. Preserve Incoming history and stored receipts. Restore the previously verified TPS Bot Interactivity URL only after the matching Call Route version is live.
