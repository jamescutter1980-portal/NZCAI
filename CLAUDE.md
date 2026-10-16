# CLAUDE.md

## No changes to the NZC Portal app without Iain's verification

Do not change the NZC Portal app (its code, pages, data handling, tests,
dependencies or configuration) unless Iain has verified the change. If a task
would change the app, stop and ask for Iain's verification first. Updating the
"what's live" log below is not a change to the app.

## Keep the "what's live" log current

`docs/whats-live.md` is the record the marketing team reads before claiming any
NZC AI or NZC Portal capability publicly. Whenever a change builds, ships,
changes or removes a user-facing feature, update it in the same pull request:

1. Add a dated entry at the top of the log with:
   - Product: NZC AI or NZC Portal, and which app or area
   - Feature: plain-English name
   - Status: Live / In beta / Coming soon / Removed
   - What a user can actually do with it today, in one or two sentences
   - Limits or caveats (e.g. "assessor sign-off required", "UK only", "manual upload only")
2. Update the status table below the log so it lists every feature once, with its current status.

Rules:

- Plain English only. No code, route names, file paths, environment variables or commands.
- Merged code is not "Live". A feature is Live only once real customers can use it in a released deployment. Built but unreleased is "Coming soon"; limited to pilot users is "In beta". When unsure, mark it not live.
- The user keeps a copy at `C:\Users\James\OneDrive\Documents\NZC-Portal-Marketing-Review\00-Whats-Live\whats-live.md`. Cloud sessions cannot write there, so mention in the PR or reply that the OneDrive copy needs refreshing.
