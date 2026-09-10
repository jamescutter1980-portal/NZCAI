"""Path patterns to handler names. Order matters: first match wins."""

from __future__ import annotations

import re
from typing import Optional

__all__ = ["ROUTES", "match"]

#: (method, pattern, handler name). `{name}` captures one path segment.
ROUTES: tuple[tuple[str, str, str], ...] = (
    ("GET",  "/api/health",                         "health"),
    ("GET",  "/api/inventory",                      "inventory"),
    ("GET",  "/api/figures/{id}/lineage",           "figure_lineage"),
    ("POST", "/api/figures/{id}/supersede",         "supersede_figure"),
    ("GET",  "/api/coverage",                       "coverage"),
    ("GET",  "/api/screen",                         "screen"),
    ("GET",  "/api/counterparties",                 "list_counterparties"),
    ("POST", "/api/counterparties",                 "create_counterparty"),
    ("GET",  "/api/counterparties/{id}",            "counterparty_dossier"),
    ("GET",  "/api/plan",                           "plan"),
    ("GET",  "/api/engagements",                    "list_engagements"),
    ("POST", "/api/engagements",                    "create_engagement"),
    ("GET",  "/api/engagements/{id}",               "get_engagement"),
    ("POST", "/api/engagements/{id}/transition",    "transition_engagement"),
    ("GET",  "/api/engagements/{id}/audit",         "engagement_audit"),
    ("GET",  "/api/documents",                      "list_documents"),
    ("POST", "/api/documents",                      "create_document"),
    ("GET",  "/api/review",                         "review_queue"),
    ("POST", "/api/review/proposals/{id}",          "decide_proposal"),
    ("POST", "/api/review/conflicts/{id}",          "decide_conflict"),
    ("POST", "/api/ingest/{kind}",                  "ingest"),
)

_compiled = [
    (m, re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", p) + "$"), h) for m, p, h in ROUTES
]


def match(method: str, path: str) -> Optional[tuple[str, dict[str, str]]]:
    """The handler name and path parameters, or None. A path that exists for
    another method returns ("method_not_allowed", {})."""
    path_exists = False
    for m, rx, h in _compiled:
        mm = rx.match(path)
        if mm:
            if m == method.upper():
                return h, mm.groupdict()
            path_exists = True
    return ("method_not_allowed", {}) if path_exists else None
