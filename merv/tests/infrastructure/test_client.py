from __future__ import annotations

import httpx
import jwt
import pytest

from merv.brain.infrastructure.client import (
    InfrastructureClient, InfrastructureUnavailableError, build_infrastructure_client,
    project_namespace,
)
from merv.shared.errors import NotFoundError, PermissionDeniedError, ValidationError


SECRET = "integration-test-secret-material-32-bytes"


def test_namespace_credentials_are_short_lived_and_never_follow_redirects():
    calls = []

    def handler(request):
        claims = jwt.decode(request.headers["authorization"][7:], SECRET,
                            algorithms=["HS256"], audience="merv-sandboxes", issuer="merv")
        calls.append((str(request.url), claims))
        assert claims["exp"] - claims["iat"] == 120
        assert claims["sub"] == "merv-control"
        return httpx.Response(200, json={"sandboxes": []})

    client = InfrastructureClient(url="https://infra.test", secret=SECRET, transport=httpx.MockTransport(handler))
    client.request("GET", "/sandboxes", namespace=project_namespace("proj_a"))
    client.request("GET", "/sandboxes", namespace=project_namespace("proj_b"))
    assert [call[1]["namespace"] for call in calls] == ["merv-project-proj_a", "merv-project-proj_b"]
    assert all(call[0] == "https://infra.test/v1/sandboxes" for call in calls)
    client.close()


@pytest.mark.parametrize("status,error", [(401, PermissionDeniedError), (403, PermissionDeniedError),
                                        (404, NotFoundError), (500, InfrastructureUnavailableError)])
def test_upstream_errors_do_not_disclose_body_or_tokens(status, error):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json={
        "error": {"code": "denied", "message": "credential=SECRET", "details": {"token": "SECRET"}}}))
    client = InfrastructureClient(url="https://infra.test", secret=SECRET, transport=transport)
    with pytest.raises(error) as caught:
        client.request("GET", "/sandboxes", namespace="merv-project-proj_a")
    assert "SECRET" not in str(caught.value) + str(caught.value.details)
    assert caught.value.details["status"] == status


def test_health_distinguishes_configured_from_authenticated():
    client = InfrastructureClient(url="https://infra.test", secret=SECRET,
                                  transport=httpx.MockTransport(lambda request: httpx.Response(403)))
    assert client.health()["ok"] is False


@pytest.mark.parametrize("url", ["https://secret@infra.test", "https://infra.test/v1", "file:///tmp/a", "https://infra.test?token=x"])
def test_invalid_configuration_fails_without_request(url):
    with pytest.raises(ValidationError):
        InfrastructureClient(url=url, secret=SECRET)


def test_partial_configuration_and_namespace_escape_fail():
    with pytest.raises(ValidationError):
        build_infrastructure_client({"MERV_SANDBOXES_URL": "https://infra.test"})
    for value in ["../proj", "foo/bar", "a" * 51, ""]:
        with pytest.raises(ValidationError):
            project_namespace(value)


@pytest.mark.parametrize("path", ["//evil.test", "/https://evil.test", "/../tokens", "/a?x=1", "/a\\b"])
def test_api_path_cannot_redirect_signed_credentials(path):
    def forbidden(request):
        raise AssertionError("invalid path reached transport")
    client = InfrastructureClient(url="https://infra.test", secret=SECRET,
                                  transport=httpx.MockTransport(forbidden))
    with pytest.raises(ValidationError):
        client.request("GET", path, namespace="merv-control")


def test_budget_rejection_exposes_only_safe_policy_amounts():
    client = InfrastructureClient(url="https://infra.test", secret=SECRET,
        transport=httpx.MockTransport(lambda request: httpx.Response(400, json={"error": {
            "code": "validation", "message": "SECRET", "details": {
                "reason": "merv_daily_budget_exceeded", "scope": "provider_payer",
                "cap_usd": "50", "accrued_and_reserved_usd": "48.30",
                "requested_lease_usd": "3", "credentials": "SECRET"}}})))
    with pytest.raises(ValidationError) as caught:
        client.request("POST", "/sandboxes", namespace="merv-project-proj_a")
    assert caught.value.details["cap_usd"] == "50"
    assert caught.value.details["reason"] == "merv_daily_budget_exceeded"
    assert "SECRET" not in str(caught.value) + str(caught.value.details)
