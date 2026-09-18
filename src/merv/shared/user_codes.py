"""The short code a human reads off one machine and types into another.

Both ends of runner pairing hold it: the brain mints and normalises the code,
the machine-local runner prints it. Crockford base32 minus I, L, O and U, so a
code is unambiguous read aloud or typed, and the substitutions people make
anyway map back onto the characters they meant.
"""

from __future__ import annotations

USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
USER_CODE_LENGTH = 8  # 32^8 = 2^40


def format_user_code(code: str) -> str:
    """``7Q2KM4B9`` → ``7Q2K-M4B9`` for display."""
    return f"{code[:4]}-{code[4:]}" if len(code) == USER_CODE_LENGTH else code


def normalize_user_code(value: object) -> str:
    """A typed code back to its stored form, or ``""`` when it is not one."""
    text = "".join(
        character
        for character in str(value or "").upper()
        if character not in " -_\t\r\n"
    )
    text = text.replace("I", "1").replace("L", "1").replace("O", "0")
    if len(text) != USER_CODE_LENGTH or any(c not in USER_CODE_ALPHABET for c in text):
        return ""
    return text
