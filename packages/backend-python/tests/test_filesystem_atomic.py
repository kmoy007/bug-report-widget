"""FilesystemStore never shows a half-written report.

put_bug used to truncate then write, so a concurrent get_bug saw an empty file
(StoreError "could not read ...") and list_bugs silently dropped the report;
a crash mid-write left a corrupt one. Writes are now temp file + os.replace.
"""

from __future__ import annotations

import os
import threading
import time
from unittest import mock

import pytest

from bug_report.store import BugRecord, FilesystemStore, StoreError


def _bug(**kw):
    base = dict(id="bug-20261020-000000-aaaaaa", title="t", details="x" * 20000, tags=["bug"],
                status="open", added_by="web", actor_email="", added_at="2026-10-20T00:00:00.000Z")
    base.update(kw)
    return BugRecord(**base)


def _temps(d):
    return [n for n in os.listdir(d) if n.endswith(".tmp")]


def test_a_read_and_a_listing_never_see_a_half_written_report(tmp_path, monkeypatch):
    monkeypatch.setattr("bug_report.store.READ_ATTEMPTS", 1)    # the retry must not be what hides a torn read
    store = FilesystemStore(tmp_path)
    bug = _bug()
    store.put_bug(bug, None)
    stop = threading.Event()

    def write():
        i = 0
        while not stop.is_set():
            bug.status = ("triaged", "open")[i % 2]
            store.put_bug(bug, None)
            i += 1

    w = threading.Thread(target=write)
    w.start()
    errors, reads = [], 0
    end = time.time() + 1.5
    try:
        while time.time() < end:
            try:
                store.get_bug(bug.id)
                if [b.id for b in store.list_bugs(status=None, since_iso="")] != [bug.id]:
                    errors.append("listing dropped the report")
            except StoreError as e:
                errors.append(e)
            reads += 1
    finally:
        stop.set()
        w.join()
    assert reads > 50
    assert errors == []


def test_no_temp_file_is_left_or_listed(tmp_path):
    store = FilesystemStore(tmp_path)
    bug = _bug()
    store.put_bug(bug, b"\x89PNG")
    assert sorted(os.listdir(tmp_path)) == [f"{bug.id}.json", f"{bug.id}.png"]
    assert [b.id for b in store.list_bugs(status=None, since_iso="")] == [bug.id]
    assert store.get_screenshot(bug.id) == b"\x89PNG"


def test_a_leftover_temp_is_never_listed(tmp_path):
    store = FilesystemStore(tmp_path)
    (tmp_path / ".bug-1.json.abc.tmp").write_text("{")
    assert list(store.list_bugs(status=None, since_iso="")) == []


def test_a_share_that_refuses_the_rename_still_saves_and_says_so(tmp_path, caplog):
    store = FilesystemStore(tmp_path)
    bug = _bug()
    with mock.patch("os.replace", side_effect=PermissionError), caplog.at_level("WARNING"):
        store.put_bug(bug, b"\x89PNG")
    assert store.get_bug(bug.id).id == bug.id
    assert store.get_screenshot(bug.id) == b"\x89PNG"
    assert _temps(tmp_path) == []
    assert "os.replace refused" in caplog.text


def test_a_failing_temp_write_leaves_the_report_intact(tmp_path):
    store = FilesystemStore(tmp_path)
    bug = _bug()
    store.put_bug(bug, None)
    before = (tmp_path / f"{bug.id}.json").read_text()
    bug.status = "triaged"
    with mock.patch("os.fsync", side_effect=OSError(28, "no space")):
        with pytest.raises(OSError):
            store.put_bug(bug, None)
    assert (tmp_path / f"{bug.id}.json").read_text() == before
    assert _temps(tmp_path) == []


def test_two_writers_of_one_bug_never_mix_their_bytes(tmp_path):
    store = FilesystemStore(tmp_path)
    bug = _bug()
    store.put_bug(bug, None)
    barrier = threading.Barrier(2)

    def write(status, pad, n):
        mine = _bug(status=status, details=pad * n)    # different lengths: a shared temp would mix them
        barrier.wait()
        for _ in range(200):
            store.put_bug(mine, None)

    ts = [threading.Thread(target=write, args=("triaged", "a", 5000)),
          threading.Thread(target=write, args=("declined", "b", 30000))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    got = store.get_bug(bug.id)
    assert (got.status, set(got.details)) in [("triaged", {"a"}), ("declined", {"b"})]
    assert _temps(tmp_path) == []


def test_a_corrupt_report_still_raises_after_the_retries(tmp_path):
    store = FilesystemStore(tmp_path)
    (tmp_path / "bug-1.json").write_text("")
    with mock.patch("bug_report.store.READ_PAUSE", 0):
        with pytest.raises(StoreError):
            store.get_bug("bug-1")


def test_stale_temp_files_are_swept_at_start_and_fresh_ones_kept(tmp_path):
    old, new = tmp_path / ".old.tmp", tmp_path / ".new.tmp"
    for p in (old, new):
        p.write_text("")
    os.utime(old, (time.time() - 3600,) * 2)
    FilesystemStore(tmp_path)
    assert sorted(os.listdir(tmp_path)) == [".new.tmp"]


def test_a_new_report_has_a_plain_writes_mode(tmp_path):
    old = os.umask(0o022)
    try:
        store = FilesystemStore(tmp_path)
        bug = _bug()
        store.put_bug(bug, b"\x89PNG")
    finally:
        os.umask(old)
    for name in (f"{bug.id}.json", f"{bug.id}.png"):
        assert (tmp_path / name).stat().st_mode & 0o777 == 0o644


def test_a_read_retries_a_report_that_is_briefly_unparseable(tmp_path):
    store = FilesystemStore(tmp_path)
    bug = _bug()
    store.put_bug(bug, None)
    path = tmp_path / f"{bug.id}.json"
    good = path.read_text()
    path.write_text("")
    calls = []
    real = type(path).read_text

    def heal(self, *a, **k):
        calls.append(1)
        if len(calls) == 2:
            path.write_text(good)
        return real(self, *a, **k)

    with mock.patch.object(type(path), "read_text", heal):
        assert store.get_bug(bug.id).id == bug.id
    assert len(calls) >= 2
