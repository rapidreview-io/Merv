"""Minimal OAuth 2.1 policy for project-scoped MCP credentials."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib.parse import urlencode, urlsplit, urlunsplit

from ..kernel.secret_tokens import hash_secret, mint_secret, secret_digest_matches
from ..kernel.utils import NotFoundError, iso_after, new_id, now_iso, parse_iso
from .project_keys import GRANT_SCOPES, PROJECT_GRANT, ProjectKeyControl
from .runner_pairing import USER_CODE_ALPHABET, USER_CODE_LENGTH, format_user_code

AUTHORIZATION_CODE_TTL_SECONDS = 60
# Consent chose "agent on another machine": the code travels by hand (curl or
# paste on the remote host), so it gets the RFC 6749 §4.1.2 maximum instead of
# the redirect budget. Still single-use and PKCE-bound.
HANDOFF_AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60
# Short single-use handoff links: the typeable curl target that finishes a
# remote sign-in and the phone pickup code for a pending consent. Same code
# space as device/runner user codes (32^8 = 2^40), same ten-minute budget.
HANDOFF_LINK_TTL_SECONDS = 10 * 60
ACCESS_TOKEN_TTL_SECONDS = 3600
REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
# Public DCR is unauthenticated, so a client that registered and never came
# back to authorize is swept (audit AUTH-03). Used clients — anything with a
# code or refresh token — are kept regardless of age.
UNUSED_CLIENT_TTL_DAYS_ENV_VAR = "MERV_OAUTH_CLIENT_TTL_DAYS"
DEFAULT_UNUSED_CLIENT_TTL_DAYS = 30
# The TTL sweep needs someone to call it, and nothing in the shipped compose
# file schedules one. These bound the table without any external timer: the
# registration path prunes a little every time, and at the cap it EVICTS the
# oldest never-used rows to admit the new client. Eviction rather than refusal,
# because DCR is unauthenticated: a cap that refuses hands anyone an onboarding
# denial of service for the price of some valid metadata. Both deletion budgets
# are per-call so the work under the store's writer lock stays bounded.
MAX_CLIENTS_ENV_VAR = "MERV_OAUTH_MAX_CLIENTS"
DEFAULT_MAX_CLIENTS = 500
OPPORTUNISTIC_PRUNE_LIMIT = 100
CAP_EVICTION_LIMIT = 100

_PKCE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_PKCE_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
_CODE_DIGEST = re.compile(r"^[0-9a-f]{64}$")
# ``refresh_token`` only rides along; the authorization code is the one grant
# a client can hold on its own, so every client registers redirect URIs.
_SUPPORTED_GRANTS = frozenset(("authorization_code", "refresh_token"))


class OAuthError(Exception):
    """Protocol error safe to return from an OAuth endpoint."""

    def __init__(
        self,
        error: str,
        description: str,
        *,
        redirect_uri: str | None = None,
        state: str | None = None,
    ) -> None:
        super().__init__(description)
        self.error = error
        self.description = description
        self.redirect_uri = redirect_uri
        self.state = state


@dataclass(frozen=True, slots=True)
class OAuthClient:
    client_id: str
    client_name: str
    redirect_uris: tuple[str, ...]
    grant_types: tuple[str, ...]
    created_at: str


@dataclass(frozen=True, slots=True)
class AuthorizationCode:
    code_digest: str
    client_id: str
    redirect_uri: str
    owner_user_id: str
    project_id: str
    grant_scope: str
    code_challenge: str
    resource: str
    created_at: str
    expires_at: str
    consumed_at: str | None


@dataclass(frozen=True, slots=True)
class HandoffLink:
    token_digest: str
    kind: str
    payload: str
    client_ip: str
    created_at: str
    expires_at: str
    consumed_at: str | None


@dataclass(frozen=True, slots=True)
class RefreshToken:
    id: str
    family_id: str
    secret_digest: str
    client_id: str
    owner_user_id: str
    project_id: str
    grant_scope: str
    resource: str
    current_key_id: str
    parent_token_id: str | None
    created_at: str
    expires_at: str
    consumed_at: str | None
    revoked_at: str | None



class OAuthRepository(Protocol):
    def get_or_create_client(self, *, client: OAuthClient) -> OAuthClient: ...
    def client_by_id(self, *, client_id: str) -> OAuthClient | None: ...
    def insert_code(self, *, code: AuthorizationCode) -> None: ...
    def code_by_digest(self, *, digest: str) -> AuthorizationCode | None: ...
    def consume_code(self, *, digest: str, consumed_at: str) -> bool: ...
    def insert_handoff_link(self, *, link: HandoffLink) -> None: ...
    def consume_handoff_link(
        self, *, digest: str, kind: str, consumed_at: str
    ) -> str | None: ...
    def insert_refresh_token(self, *, token: RefreshToken) -> None: ...
    def refresh_token_by_digest(self, *, digest: str) -> RefreshToken | None: ...
    def consume_refresh_token(self, *, token_id: str, consumed_at: str) -> bool: ...
    def revoke_refresh_family_and_key_lineage(
        self,
        *,
        family_id: str,
        key_id: str,
        project_id: str,
        owner_user_id: str,
        revoked_at: str,
    ) -> None: ...


class OAuthControl(Protocol):
    def register_client(self, metadata: dict[str, Any]) -> dict[str, Any]: ...
    def authorization_details(self, **kwargs: object) -> dict[str, Any]: ...
    def authorize(self, **kwargs: object) -> str: ...
    def authorization_status(self, **kwargs: object) -> str: ...
    def mint_handoff_link(self, **kwargs: object) -> str: ...
    def consume_handoff_link(self, **kwargs: object) -> str | None: ...
    def exchange_code(self, **kwargs: object) -> dict[str, Any]: ...
    def refresh(self, **kwargs: object) -> dict[str, Any]: ...


class ProjectMembership(Protocol):
    def __call__(self, *, project_id: str, user_id: str) -> bool: ...


@dataclass(frozen=True, slots=True)
class AuthorizationRequest:
    client: OAuthClient
    redirect_uri: str
    state: str | None
    code_challenge: str
    resource: str


class OAuthService:
    """DCR, authorization-code, and refresh-rotation application policy."""

    def __init__(
        self,
        *,
        repository: OAuthRepository,
        project_keys: ProjectKeyControl,
        is_project_member: ProjectMembership,
    ) -> None:
        self._repository = repository
        self._project_keys = project_keys
        self._is_project_member = is_project_member

    def register_client(self, metadata: dict[str, Any]) -> dict[str, Any]:
        raw_name = metadata.get("client_name")
        name = raw_name.strip() if isinstance(raw_name, str) else ""
        if not name or len(name) > 200 or _has_control_character(name):
            raise OAuthError(
                "invalid_client_metadata",
                "client_name is required and must be at most 200 printable characters",
            )
        grants = _string_list(
            metadata.get("grant_types", ["authorization_code"]),
            field="grant_types",
            required=True,
        )
        if "authorization_code" not in grants or not set(grants) <= _SUPPORTED_GRANTS:
            raise OAuthError(
                "invalid_client_metadata",
                "grant_types may contain only authorization_code and refresh_token",
            )
        redirect_uris = _string_list(
            metadata.get("redirect_uris"), field="redirect_uris", required=True
        )
        if len(redirect_uris) > 10:
            raise OAuthError(
                "invalid_redirect_uri", "at most 10 redirect_uris may be registered"
            )
        for uri in redirect_uris:
            if not valid_redirect_uri(uri):
                raise OAuthError(
                    "invalid_redirect_uri",
                    "redirect_uris must be exact HTTPS URLs or HTTP loopback URLs",
                )
        if metadata.get("token_endpoint_auth_method") != "none":
            raise OAuthError(
                "invalid_client_metadata",
                "only public clients with token_endpoint_auth_method=none are supported",
            )
        response_types = _string_list(
            metadata.get("response_types", ["code"]),
            field="response_types",
            required=True,
        )
        if response_types != ("code",):
            raise OAuthError(
                "invalid_client_metadata", 'only response_types=["code"] is supported'
            )
        if str(metadata.get("scope") or "").strip():
            raise OAuthError(
                "invalid_client_metadata", "registered scopes are not supported"
            )
        # Identical metadata resolves to the identical client. A public client
        # id is not a credential, and clients that re-register on every launch
        # would otherwise grow the table forever (audit AUTH-03). Both arrays
        # are sorted first so a client that merely shuffles its own list — the
        # order carries no meaning to either side — is still the same client
        # and not a fresh row per launch. This canonical form is exactly what
        # the stored metadata fingerprint (migration 38) hashes, which is why
        # rows written before canonicalization are still found by this lookup.
        client = self._repository.get_or_create_client(
            client=OAuthClient(
                client_id=new_id(prefix="oauthc"),
                client_name=name,
                redirect_uris=tuple(sorted(redirect_uris)),
                grant_types=tuple(sorted(grants)),
                created_at=now_iso(),
            )
        )
        issued = parse_iso(client.created_at)
        return {
            "client_id": client.client_id,
            "client_id_issued_at": int(issued.timestamp()) if issued else 0,
            "client_name": client.client_name,
            "redirect_uris": list(client.redirect_uris),
            "token_endpoint_auth_method": "none",
            "grant_types": list(client.grant_types),
            "response_types": ["code"],
        }

    def authorization_details(
        self, *, params: dict[str, str], canonical_resource: str
    ) -> dict[str, Any]:
        request = self._authorization_request(
            params=params, canonical_resource=canonical_resource
        )
        return {
            "client_id": request.client.client_id,
            "client_name": request.client.client_name,
            "resource": request.resource,
        }

    def authorize(
        self,
        *,
        params: dict[str, str],
        canonical_resource: str,
        issuer: str,
        owner_user_id: str,
        project_id: str,
        approved: bool,
        grant_scope: str = PROJECT_GRANT,
        handoff: bool = False,
    ) -> str:
        request = self._authorization_request(
            params=params, canonical_resource=canonical_resource
        )
        if not approved:
            return authorization_redirect(
                redirect_uri=request.redirect_uri,
                issuer=issuer,
                state=request.state,
                error="access_denied",
            )
        if grant_scope not in GRANT_SCOPES:
            return authorization_redirect(
                redirect_uri=request.redirect_uri,
                issuer=issuer,
                state=request.state,
                error="invalid_request",
            )
        # An account grant still names a home project, and membership in it is
        # still proven here: consent can never reach beyond the consenting
        # user's own membership, whichever scope they picked.
        if (
            not project_id
            or not owner_user_id
            or not self._is_project_member(project_id=project_id, user_id=owner_user_id)
        ):
            return authorization_redirect(
                redirect_uri=request.redirect_uri,
                issuer=issuer,
                state=request.state,
                error="access_denied",
            )
        secret = mint_secret(prefix="mac_", nbytes=32)
        self._repository.insert_code(
            code=AuthorizationCode(
                code_digest=hash_secret(secret),
                client_id=request.client.client_id,
                redirect_uri=request.redirect_uri,
                owner_user_id=owner_user_id,
                project_id=project_id,
                grant_scope=grant_scope,
                code_challenge=request.code_challenge,
                resource=request.resource,
                created_at=now_iso(),
                expires_at=iso_after(
                    seconds=HANDOFF_AUTHORIZATION_CODE_TTL_SECONDS
                    if handoff
                    else AUTHORIZATION_CODE_TTL_SECONDS
                ),
                consumed_at=None,
            )
        )
        return authorization_redirect(
            redirect_uri=request.redirect_uri,
            issuer=issuer,
            state=request.state,
            code=secret,
        )

    def authorization_status(self, *, digest: str) -> str:
        """Consent-page poll: has the hand-carried code been redeemed yet?

        Keyed by the code's stored sha256 digest, which the consent response
        hands the page — irreversible, so holding it proves nothing beyond
        what the page already knows (it holds the code itself).
        """
        if not _CODE_DIGEST.fullmatch(digest):
            return "unknown"
        code = self._repository.code_by_digest(digest=digest)
        if code is None:
            return "unknown"
        if code.consumed_at is not None:
            return "redeemed"
        if _expired(code.expires_at):
            return "expired"
        return "pending"

    def mint_handoff_link(
        self, *, kind: str, payload: str, client_ip: str
    ) -> str:
        """Mint a short single-use link token; display form ``AB12-CD34``.

        The insert raises ``slow_down`` at the per-IP mint cap, so a caller
        minting on the user's behalf (the consent approve) can degrade to the
        full command instead of failing the approval.
        """
        if kind not in ("deliver", "visit"):
            raise OAuthError("invalid_request", "unknown handoff link kind")
        ip = str(client_ip or "").strip()[:64]
        token = "".join(
            secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_LENGTH)
        )
        self._repository.insert_handoff_link(
            link=HandoffLink(
                token_digest=hash_secret(token),
                kind=kind,
                payload=payload,
                client_ip=ip,
                created_at=now_iso(),
                expires_at=iso_after(seconds=HANDOFF_LINK_TTL_SECONDS),
                consumed_at=None,
            )
        )
        return format_user_code(token)

    def consume_handoff_link(self, *, kind: str, token: str) -> str | None:
        """One-shot payload pickup; forgiving of dashes, case, and O/I slips."""
        text = "".join(
            character
            for character in str(token or "").upper()
            if character not in " -_"
        )
        text = text.replace("I", "1").replace("L", "1").replace("O", "0")
        if len(text) != USER_CODE_LENGTH or any(
            c not in USER_CODE_ALPHABET for c in text
        ):
            return None
        return self._repository.consume_handoff_link(
            digest=hash_secret(text), kind=kind, consumed_at=now_iso()
        )

    def exchange_code(
        self, *, form: dict[str, str], canonical_resource: str
    ) -> dict[str, Any]:
        client = self._token_client(form)
        if "authorization_code" not in client.grant_types:
            raise OAuthError(
                "unauthorized_client", "client cannot use authorization_code"
            )
        raw_code = _required_form(form, "code")
        digest = hash_secret(raw_code)
        code = self._repository.code_by_digest(digest=digest)
        if not secret_digest_matches(
            stored_digest=code.code_digest if code else None,
            presented_digest=digest,
        ):
            raise OAuthError("invalid_grant", "authorization code is invalid")
        assert code is not None
        verifier = _required_form(form, "code_verifier")
        if (
            code.client_id != client.client_id
            or code.redirect_uri != _required_form(form, "redirect_uri")
            or code.resource != _required_resource(form, canonical_resource)
            or code.consumed_at is not None
            or _expired(code.expires_at)
            or not _PKCE_VERIFIER.fullmatch(verifier)
            or not hmac.compare_digest(_s256(verifier), code.code_challenge)
        ):
            raise OAuthError("invalid_grant", "authorization code is invalid")
        if not self._repository.consume_code(digest=digest, consumed_at=now_iso()):
            raise OAuthError("invalid_grant", "authorization code is invalid")
        refresh_family_id = new_id(prefix="orf")
        minted = self._mint_access_token(
            project_id=code.project_id,
            owner_user_id=code.owner_user_id,
            parent_key_id=None,
            audience=code.resource,
            oauth_family_id=refresh_family_id,
            grant_scope=code.grant_scope,
        )
        return self._token_response(
            client=client,
            minted=minted,
            resource=code.resource,
            owner_user_id=code.owner_user_id,
            project_id=code.project_id,
            grant_scope=code.grant_scope,
            parent_refresh_token_id=None,
            refresh_family_id=refresh_family_id,
        )

    def refresh(
        self, *, form: dict[str, str], canonical_resource: str
    ) -> dict[str, Any]:
        client = self._token_client(form)
        if "refresh_token" not in client.grant_types:
            raise OAuthError("unauthorized_client", "client cannot use refresh_token")
        raw_token = _required_form(form, "refresh_token")
        digest = hash_secret(raw_token)
        token = self._repository.refresh_token_by_digest(digest=digest)
        if not secret_digest_matches(
            stored_digest=token.secret_digest if token else None,
            presented_digest=digest,
        ):
            raise OAuthError("invalid_grant", "refresh token is invalid")
        assert token is not None
        if token.consumed_at is not None:
            self._revoke_replayed_refresh(token)
            raise OAuthError("invalid_grant", "refresh token is invalid")
        if (
            token.client_id != client.client_id
            or token.resource != _required_resource(form, canonical_resource)
            or token.revoked_at is not None
            or _expired(token.expires_at)
        ):
            raise OAuthError("invalid_grant", "refresh token is invalid")
        if not self._repository.consume_refresh_token(
            token_id=token.id, consumed_at=now_iso()
        ):
            # We already established this token was unconsumed, unrevoked, and
            # unexpired above, so a failed compare-and-set means a concurrent
            # exchange consumed it first. That is refresh-token reuse: revoke
            # the whole family, exactly as the sequential-replay path does.
            self._revoke_replayed_refresh(token)
            raise OAuthError("invalid_grant", "refresh token is invalid")
        try:
            minted = self._project_keys.rotate(
                project_id=token.project_id,
                owner_user_id=token.owner_user_id,
                expires_at=iso_after(seconds=ACCESS_TOKEN_TTL_SECONDS),
                parent_key_id=token.current_key_id,
                audience=token.resource,
                oauth_family_id=token.family_id,
                grant_scope=token.grant_scope,
            )
        except NotFoundError as exc:
            raise OAuthError("invalid_grant", "refresh token is invalid") from exc
        return self._token_response(
            client=client,
            minted=minted,
            resource=token.resource,
            owner_user_id=token.owner_user_id,
            project_id=token.project_id,
            grant_scope=token.grant_scope,
            parent_refresh_token_id=token.id,
            refresh_family_id=token.family_id,
        )

    def _revoke_replayed_refresh(self, token: RefreshToken) -> None:
        self._repository.revoke_refresh_family_and_key_lineage(
            family_id=token.family_id,
            project_id=token.project_id,
            key_id=token.current_key_id,
            owner_user_id=token.owner_user_id,
            revoked_at=now_iso(),
        )

    def _authorization_request(
        self, *, params: dict[str, str], canonical_resource: str
    ) -> AuthorizationRequest:
        client_id = str(params.get("client_id") or "")
        client = self._repository.client_by_id(client_id=client_id)
        if client is None:
            raise OAuthError("invalid_request", "unknown client_id")
        redirect_uri = str(params.get("redirect_uri") or "")
        if not redirect_uri or redirect_uri not in client.redirect_uris:
            # An unregistered URI is never reflected into a redirect response.
            raise OAuthError("invalid_request", "redirect_uri is not registered")
        state = params.get("state")

        def redirectable(error: str, description: str) -> OAuthError:
            return OAuthError(
                error, description, redirect_uri=redirect_uri, state=state
            )

        if params.get("response_type") != "code":
            raise redirectable(
                "unsupported_response_type", "response_type must be code"
            )
        if params.get("code_challenge_method") != "S256":
            raise redirectable("invalid_request", "code_challenge_method must be S256")
        challenge = str(params.get("code_challenge") or "")
        if not _PKCE_CHALLENGE.fullmatch(challenge):
            raise redirectable("invalid_request", "code_challenge is invalid")
        if str(params.get("scope") or "").strip():
            raise redirectable("invalid_scope", "scopes are not supported")
        if str(params.get("response_mode") or "query") != "query":
            raise redirectable(
                "invalid_request", "only query response mode is supported"
            )
        try:
            resource = _required_resource(params, canonical_resource)
        except OAuthError as exc:
            raise redirectable(exc.error, exc.description) from exc
        return AuthorizationRequest(
            client=client,
            redirect_uri=redirect_uri,
            state=state,
            code_challenge=challenge,
            resource=resource,
        )

    def _token_client(self, form: dict[str, str]) -> OAuthClient:
        client_id = _required_form(form, "client_id")
        client = self._repository.client_by_id(client_id=client_id)
        if client is None:
            raise OAuthError("invalid_client", "unknown public client")
        return client

    def _mint_access_token(
        self,
        *,
        project_id: str,
        owner_user_id: str,
        parent_key_id: str | None,
        audience: str,
        oauth_family_id: str,
        grant_scope: str,
    ) -> dict[str, Any]:
        return self._project_keys.create(
            project_id=project_id,
            owner_user_id=owner_user_id,
            expires_at=iso_after(seconds=ACCESS_TOKEN_TTL_SECONDS),
            parent_key_id=parent_key_id,
            audience=audience,
            oauth_family_id=oauth_family_id,
            grant_scope=grant_scope,
        )

    def _token_response(
        self,
        *,
        client: OAuthClient,
        minted: dict[str, Any],
        resource: str,
        owner_user_id: str,
        project_id: str,
        grant_scope: str,
        parent_refresh_token_id: str | None,
        refresh_family_id: str | None = None,
    ) -> dict[str, Any]:
        response: dict[str, Any] = {
            "access_token": str(minted["secret"]),
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_TTL_SECONDS,
        }
        if "refresh_token" not in client.grant_types:
            return response
        raw_refresh = mint_secret(prefix="mrt_", nbytes=32)
        key = dict(minted["key"])
        token = RefreshToken(
            id=new_id(prefix="ort"),
            family_id=refresh_family_id or new_id(prefix="orf"),
            secret_digest=hash_secret(raw_refresh),
            client_id=client.client_id,
            owner_user_id=owner_user_id,
            project_id=project_id,
            grant_scope=grant_scope,
            resource=resource,
            current_key_id=str(key["id"]),
            parent_token_id=parent_refresh_token_id,
            created_at=now_iso(),
            expires_at=iso_after(seconds=REFRESH_TOKEN_TTL_SECONDS),
            consumed_at=None,
            revoked_at=None,
        )
        try:
            self._repository.insert_refresh_token(token=token)
        except Exception:
            # Do not leave an untracked bearer active if refresh persistence fails.
            self._project_keys.revoke(
                project_id=project_id,
                key_id=str(key["id"]),
                owner_user_id=owner_user_id,
            )
            raise
        response["refresh_token"] = raw_refresh
        return response


def valid_redirect_uri(uri: str) -> bool:
    if (
        not uri
        or uri != uri.strip()
        or len(uri) > 2048
        or "\\" in uri
        or _has_control_character(uri)
    ):
        return False
    try:
        parsed = urlsplit(uri)
        # Accessing port validates malformed/out-of-range port text.
        parsed.port
    except ValueError:
        return False
    if (
        parsed.fragment
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return False
    if parsed.scheme == "https":
        return True
    if parsed.scheme != "http":
        return False
    if parsed.hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


def authorization_redirect(
    *,
    redirect_uri: str,
    issuer: str,
    state: str | None,
    code: str | None = None,
    error: str | None = None,
) -> str:
    parsed = urlsplit(redirect_uri)
    query = parsed.query
    fields = [("code", code)] if code else [("error", str(error or "server_error"))]
    if state is not None:
        fields.append(("state", state))
    fields.append(("iss", issuer))
    encoded = urlencode(fields)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            f"{query}&{encoded}" if query else encoded,
            "",
        )
    )


def oauth_error_redirect(*, exc: OAuthError, issuer: str) -> str | None:
    if exc.redirect_uri is None:
        return None
    parsed = urlsplit(exc.redirect_uri)
    query = parsed.query
    fields: list[tuple[str, str]] = [("error", exc.error)]
    if exc.state is not None:
        fields.append(("state", exc.state))
    fields.append(("iss", issuer))
    encoded = urlencode(fields)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            f"{query}&{encoded}" if query else encoded,
            "",
        )
    )


def _string_list(value: Any, *, field: str, required: bool) -> tuple[str, ...]:
    if not isinstance(value, list) or (required and not value):
        raise OAuthError("invalid_client_metadata", f"{field} must be a nonempty array")
    if any(not isinstance(item, str) or not item for item in value):
        raise OAuthError("invalid_client_metadata", f"{field} must contain strings")
    result = tuple(value)
    if len(set(result)) != len(result):
        raise OAuthError(
            "invalid_client_metadata", f"{field} must not contain duplicates"
        )
    return result


def _required_form(form: dict[str, str], field: str) -> str:
    value = str(form.get(field) or "")
    if not value:
        raise OAuthError("invalid_request", f"{field} is required")
    return value


def _required_resource(values: dict[str, str], canonical_resource: str) -> str:
    resource = str(values.get("resource") or "")
    if resource != canonical_resource:
        raise OAuthError("invalid_target", "resource must identify this MCP endpoint")
    return resource


def _expired(value: str) -> bool:
    expiry = parse_iso(value)
    return expiry is None or expiry <= datetime.now(UTC)


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _has_control_character(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)



__all__ = [
    "ACCESS_TOKEN_TTL_SECONDS",
    "AUTHORIZATION_CODE_TTL_SECONDS",
    "DEFAULT_UNUSED_CLIENT_TTL_DAYS",
    "HANDOFF_AUTHORIZATION_CODE_TTL_SECONDS",
    "HANDOFF_LINK_TTL_SECONDS",
    "HandoffLink",
    "OAuthControl",
    "OAuthError",
    "OAuthService",
    "REFRESH_TOKEN_TTL_SECONDS",
    "UNUSED_CLIENT_TTL_DAYS_ENV_VAR",
    "authorization_redirect",
    "oauth_error_redirect",
    "valid_redirect_uri",
]
