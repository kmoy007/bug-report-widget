"""Bug-report backend for Python apps.

Wire it into any Flask app:

    from flask import Flask
    from bug_report import create_blueprint, FilesystemStore

    app = Flask(__name__)
    app.register_blueprint(create_blueprint(
        store=FilesystemStore("/var/lib/bugs"),
        is_admin=lambda req: req.headers.get("X-Admin") == "yes",  # your auth
    ), url_prefix="/api")

Implements the contract in ../spec/openapi.yaml. Cross-stack contract tests
in ../../e2e enforce that this and the Node backend stay honest.
"""

from .blueprint import create_blueprint
from .store import (
    Store,
    StoreError,
    NotFound,
    InMemoryStore,
    FilesystemStore,
)
from .models import (
    BUG_DETAILS_MAX,
    BUG_SCREENSHOT_MAX,
    BUG_STATUSES,
    new_bug_id,
    valid_bug_id,
)

__version__ = "1.0.0"

__all__ = [
    "create_blueprint",
    "Store",
    "StoreError",
    "NotFound",
    "InMemoryStore",
    "FilesystemStore",
    "BUG_DETAILS_MAX",
    "BUG_SCREENSHOT_MAX",
    "BUG_STATUSES",
    "new_bug_id",
    "valid_bug_id",
]
