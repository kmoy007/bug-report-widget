"""The screenshot media type, sniffed from the bytes.

Kept apart from test_blueprint.py because this is the pure model-layer
function: no Flask, no store, no HTTP. `packages/backend-node/tests/
router.test.js` holds the mirror of these cases — the two implementations
are meant to agree byte for byte.
"""

from __future__ import annotations

import pytest

from bug_report.models import screenshot_content_type

PNG = bytes.fromhex("89504E470D0A1A0A") + b"rest of the file"
JPEG = bytes.fromhex("FFD8FFE0") + b"rest of the file"
GIF87 = b"GIF87a" + b"rest of the file"
GIF89 = b"GIF89a" + b"rest of the file"
WEBP = b"RIFF" + (1234).to_bytes(4, "little") + b"WEBPVP8 rest"


@pytest.mark.parametrize("data,expected", [
    (PNG, "image/png"),
    (JPEG, "image/jpeg"),
    (GIF87, "image/gif"),
    (GIF89, "image/gif"),
    (WEBP, "image/webp"),
])
def test_recognised_formats(data, expected):
    assert screenshot_content_type(data) == expected


@pytest.mark.parametrize("data", [
    b"",                                   # nothing stored
    b"not an image at all",                # junk
    b"\x89PNG",                            # truncated magic
    b"RIFF" + (10).to_bytes(4, "little") + b"WAVE",   # RIFF, but not WebP
])
def test_unrecognised_bytes_keep_the_historical_default(data):
    """image/png, not octet-stream. Every deployment before this returned
    image/png for everything, so anything unrecognised must keep doing what
    it did — the fix is for the formats we can positively identify, not a
    licence to start refusing bytes that used to render."""
    assert screenshot_content_type(data) == "image/png"


def test_a_jpeg_one_byte_short_of_its_magic_is_not_a_jpeg():
    assert screenshot_content_type(b"\xff\xd8") == "image/png"
