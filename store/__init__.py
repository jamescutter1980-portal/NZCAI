"""Persistence for the NZC AI engines.

`repository.Store` is the working implementation on SQLite. `migrations/`
holds the production schema for Supabase or any Postgres, with row-level
security keyed on organisation membership.

The store never computes a number. It persists what the engines produce and
hands it back, and it makes two invariants physical: figures and audit rows
cannot be updated or deleted, and a state change cannot be written without
its audit row.
"""

from .repository import NotFound, Proposal, Store

__all__ = ["Store", "NotFound", "Proposal"]
