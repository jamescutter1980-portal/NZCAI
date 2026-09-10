"""HTTP surface over the store and the engines.

`handlers.py` is the API: plain functions taking a request context and
returning a status and a JSON-able payload. It has no knowledge of HTTP
framing, so it is tested directly and can be mounted on any server.
`server.py` is the standard-library adapter used for local runs and the
front end; a production deployment swaps it for whatever host the
platform provides without touching a handler.

Organisation scoping is by the `X-Org-Id` header here. In production the
organisation comes from the caller's session token and the header is not
trusted; the adapter is the only place that changes.
"""

from .handlers import Context, HttpError, handle
from .router import ROUTES, match

__all__ = ["Context", "HttpError", "handle", "ROUTES", "match"]
