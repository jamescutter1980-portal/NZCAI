# Site Intelligence fixtures

**These are constructed to the documented response shape, not recorded from
live endpoints.** This build had no network access to planning.data.gov.uk, so
nothing here is a true recording.

Before relying on them, run `npm run site:verify` from an unrestricted network:
it calls the real endpoints, checks the configured dataset slugs exist, and
prints the actual field names so these files can be replaced with genuine
recordings.

Brief section 9 asks for 8 confirmed fixture sites. None have been chosen yet —
that needs James.
