"""The lifecycle contract, and this backend's agreement with it.

`packages/spec/report-contract.json` is the source of truth;
`bug_report/contract.py` is this backend's mirror. The spec README's rule
applies to the lifecycle exactly as it does to the wire format: change it
there first.
"""
import json
import pathlib

import pytest

from bug_report import contract
from bug_report.models import BUG_STATUSES

SPEC = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "spec" / "report-contract.json").read_text()
)


def test_the_mirror_matches_the_spec():
    assert list(contract.STATUSES) == SPEC["statuses"]
    assert list(contract.CLOSED_STATUSES) == SPEC["closedStatuses"]
    assert {k: list(v) for k, v in contract.TRANSITIONS.items()} == SPEC["transitions"]
    assert {k: list(v) for k, v in contract.OFFERED.items()} == SPEC["offered"]
    assert list(contract.REASON_REQUIRED_FOR) == SPEC["reasonRequiredFor"]
    assert list(contract.KINDS) == SPEC["kinds"]
    assert contract.DEFAULT_KIND == SPEC["defaultKind"]
    assert {k: list(v) for k, v in contract.KIND_TAGS.items()} == SPEC["kindTags"]


def test_the_status_enum_and_the_contract_agree():
    # models.BUG_STATUSES predates the contract and is what the route
    # validates membership against. If these ever drift, one of the two
    # moved and somebody has to look.
    assert list(BUG_STATUSES) == SPEC["statuses"]


@pytest.mark.parametrize("frm", SPEC["statuses"])
def test_accepts_exactly_the_spec_transitions(frm):
    # Both directions: an earlier draft of this contract said a server
    # "may accept more", which is how two apps behaved differently and
    # both passed.
    allowed = SPEC["transitions"][frm]
    for to in SPEC["statuses"]:
        if to == frm:
            continue  # same-status is the documented no-op, not a move
        assert contract.is_valid_transition(frm, to) is (to in allowed), f"{frm} -> {to}"


def test_offered_is_a_subset_of_accepted():
    for frm, tos in SPEC["offered"].items():
        for to in tos:
            assert to in SPEC["transitions"][frm], f"UI offers {frm} -> {to}; server forbids it"


def test_kind_is_derived_the_same_way_everywhere():
    assert contract.kind_from_tags(["bug"]) == "bug"
    assert contract.kind_from_tags([]) == "bug"
    assert contract.kind_from_tags(["feature-request"]) == "feature"
    # The widget adds `bug` unconditionally, so "has a bug tag" says
    # nothing — in either order.
    assert contract.kind_from_tags(["bug", "feature-request"]) == "feature"
    assert contract.kind_from_tags(["feature-request", "bug"]) == "feature"


def test_the_retired_capability_tag_reads_as_a_feature():
    # `capability` stopped being a kind; rows carrying the old tag must
    # read as what they always were rather than falling back to `bug`.
    assert "capability" not in contract.KINDS
    assert contract.kind_from_tags(["capability-request"]) == "feature"


def test_every_derived_kind_is_a_declared_kind():
    for tags in ([], ["bug"], ["feature-request"], ["capability-request"], ["nonsense"]):
        assert contract.kind_from_tags(tags) in SPEC["kinds"]


def test_closed_is_defined_by_exclusion():
    # A status this contract has never heard of counts as OPEN. A triage
    # list that silently drops an unrecognised report is the worse of the
    # two failures.
    assert contract.is_closed("resolved") and contract.is_closed("declined")
    assert not contract.is_closed("open")
    assert not contract.is_closed("triaged")
    assert not contract.is_closed("something-a-future-app-invented")


def test_with_kind_is_idempotent():
    payload = {"tags": ["bug", "feature-request"]}
    assert contract.with_kind(contract.with_kind(payload))["kind"] == "feature"
