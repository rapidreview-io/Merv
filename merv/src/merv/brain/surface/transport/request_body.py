"""Bounded request-body streaming shared by public HTTP adapters."""

from __future__ import annotations

from fastapi import Request


class RequestBodyTooLarge(Exception):
    def __init__(self, *, limit: int) -> None:
        super().__init__(f"request body exceeds {limit} bytes")
        self.limit = int(limit)


async def read_limited_body(request: Request, *, limit: int) -> bytes:
    """Read at most ``limit`` bytes without calling Starlette's body buffer.

    INV-6: a declared Content-Length over the limit is refused before any read,
    and each chunk is checked on its PROJECTED size before it is appended, so
    one oversized ASGI chunk is never allocated past the limit.
    """
    declared = request.headers.get("Content-Length", "").strip()
    if declared:
        try:
            if int(declared) > limit:
                raise RequestBodyTooLarge(limit=limit)
        except ValueError:
            pass
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise RequestBodyTooLarge(limit=limit)
        body.extend(chunk)
    return bytes(body)


async def read_capped_body(request: Request, *, cap: int) -> bytes | None:
    """The same read for a caller that answers 413 instead of raising."""
    try:
        return await read_limited_body(request, limit=cap)
    except RequestBodyTooLarge:
        return None


__all__ = ["RequestBodyTooLarge", "read_capped_body", "read_limited_body"]
