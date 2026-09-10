from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from merv.brain.infrastructure.client import (
    InfrastructureClient, InfrastructureUnavailableError, build_infrastructure_client,
    infrastructure_actor, project_namespace,
)
from merv.shared.errors import NotFoundError, PermissionDeniedError, ValidationError

CONNECTIONS = {'proj_a': {'namespace': 'research-a', 'token': 'sbxt_test-a'},
               'proj_b': {'namespace': 'research-b', 'token': 'sbxt_test-b'}}


def client_for(handler):
    def authenticated(request):
        if request.url.path == '/v1/auth/me':
            return httpx.Response(200, json={'role': 'consumer',
                'namespace': request.headers['x-sandbox-namespace']})
        return handler(request)
    return InfrastructureClient(url='https://infra.test', connections=CONNECTIONS,
                                transport=httpx.MockTransport(authenticated))


def test_requests_use_explicit_grants_and_actor_without_budget_claims():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'subject': request.headers.get('x-sandbox-subject')})
    client = client_for(handler)
    with infrastructure_actor('user-a'):
        client.request('POST', '/sandboxes', namespace=project_namespace('proj_a'), json={'lease_seconds': 600})
    client.request('GET', '/sandboxes', namespace='proj_b')
    assert calls[0].headers['authorization'] == 'Bearer sbxt_test-a'
    assert calls[0].headers['x-sandbox-namespace'] == 'research-a'
    assert calls[0].headers['x-sandbox-subject'] == 'user-a'
    assert json.loads(calls[0].content) == {'lease_seconds': 600}
    assert calls[1].headers['authorization'] == 'Bearer sbxt_test-b'
    assert 'x-sandbox-subject' not in calls[1].headers
    assert all(str(call.url) == 'https://infra.test/v1/sandboxes' for call in calls)
    def call(user):
        with infrastructure_actor(user):
            return client.request('GET', '/sandboxes', namespace='proj_a')['subject']
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(call, ['a', 'b', 'c', 'd'])) == ['a', 'b', 'c', 'd']
    with pytest.raises(RuntimeError), infrastructure_actor('failed'):
        raise RuntimeError('abort')
    assert client.request('GET', '/sandboxes', namespace='proj_a')['subject'] is None
    client.close()


@pytest.mark.parametrize('status,error', [(401, PermissionDeniedError), (403, PermissionDeniedError),
                                        (404, NotFoundError), (500, InfrastructureUnavailableError)])
def test_upstream_errors_do_not_disclose_body_or_tokens(status, error):
    client = client_for(lambda request: httpx.Response(status, json={
        'error': {'code': 'denied', 'message': 'credential=SECRET', 'details': {'token': 'SECRET'}}}))
    with pytest.raises(error) as caught:
        client.request('GET', '/sandboxes', namespace='proj_a')
    assert 'SECRET' not in str(caught.value) + str(caught.value.details)
    assert caught.value.details['status'] == status


def test_health_is_not_a_project_operation():
    def handler(request):
        assert request.url.path == '/healthz'
        assert 'authorization' not in request.headers
        return httpx.Response(200, json={'status': 'ok'})
    assert client_for(handler).health()['ok'] is True
    assert client_for(lambda request: httpx.Response(503)).health()['ok'] is False


@pytest.mark.parametrize('url', ['https://secret@infra.test', 'https://infra.test/v1', 'file:///tmp/a', 'https://infra.test?token=x'])
def test_invalid_configuration_fails_without_request(url):
    with pytest.raises(ValidationError):
        InfrastructureClient(url=url, connections=CONNECTIONS)


def test_partial_configuration_and_namespace_escape_fail(tmp_path):
    with pytest.raises(ValidationError):
        build_infrastructure_client({'MERV_SANDBOXES_URL': 'https://infra.test'})
    for value in ['../proj', 'foo/bar', 'a' * 51, '']:
        with pytest.raises(ValidationError):
            project_namespace(value)
    config = tmp_path / 'connections.json'
    config.write_text(json.dumps(CONNECTIONS))
    client = build_infrastructure_client({'MERV_SANDBOXES_URL': 'https://infra.test',
                                         'MERV_SANDBOXES_CONNECTIONS_FILE': str(config)})
    assert client is not None
    client.close()


@pytest.mark.parametrize('path', ['//evil.test', '/https://evil.test', '/../tokens', '/a?x=1', '/a\\b'])
def test_api_path_cannot_redirect_credentials(path):
    def forbidden(request):
        raise AssertionError('invalid path reached transport')
    with pytest.raises(ValidationError):
        client_for(forbidden).request('GET', path, namespace='proj_a')


def test_unmapped_project_fails_before_sending_credentials():
    def forbidden(request):
        raise AssertionError('unmapped project reached transport')
    with pytest.raises(ValidationError, match='no authorized'):
        client_for(forbidden).request('GET', '/sandboxes', namespace='unknown')


def test_redirects_are_not_followed():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(307, headers={'location': 'https://attacker.invalid'})
    with pytest.raises(InfrastructureUnavailableError):
        client_for(handler).request('GET', '/sandboxes', namespace='proj_a')
    assert len(calls) == 1


def test_budget_denial_exposes_only_reason():
    client = client_for(lambda request: httpx.Response(400, json={'error': {
        'code': 'validation', 'message': 'SECRET', 'details': {
            'reason': 'budget_exceeded', 'token': 'SECRET', 'accrued': '123'}}}))
    with pytest.raises(ValidationError) as caught:
        client.request('POST', '/sandboxes', namespace='proj_a')
    assert caught.value.details['reason'] == 'budget_exceeded'
    assert 'SECRET' not in str(caught.value) + str(caught.value.details)
    assert 'accrued' not in caught.value.details


@pytest.mark.parametrize('role,namespace,status', [
    ('admin', 'research-a', 200), ('consumer', 'wrong-namespace', 200),
    ('consumer', 'research-a', 401),
])
def test_invalid_grant_is_rejected_before_resource_mutation(role, namespace, status):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.path == '/v1/auth/me'
        return httpx.Response(status, json={'role': role, 'namespace': namespace})
    client = InfrastructureClient(url='https://infra.test', connections=CONNECTIONS,
                                  transport=httpx.MockTransport(handler))
    with pytest.raises(PermissionDeniedError):
        client.request('POST', '/sandboxes', namespace='proj_a', json={'lease_seconds': 60})
    assert len(calls) == 1


@pytest.mark.parametrize('entry', [
    {'namespace': 123, 'token': 'sbxt_test'},
    {'namespace': 'a', 'token': 'sbxt_test\nheader'},
    {'namespace': 'a', 'token': None},
])
def test_connection_values_are_validated_without_coercion(entry):
    with pytest.raises(ValidationError):
        InfrastructureClient(url='https://infra.test', connections={'proj_a': entry})
