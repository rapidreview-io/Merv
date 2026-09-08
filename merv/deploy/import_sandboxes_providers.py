#!/usr/bin/env python3
"""Verify and optionally import restricted staged project credentials in the native service.

Input is the mode-0600 native-own-provider-import.json created by staging.
Only --apply saves credentials; old Merv secrets are scrubbed separately after
the imported connection has been verified. No compute resources are allocated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


async def run(apply: bool) -> None:
    from merv_sandboxes.config import Settings
    from merv_sandboxes.core.clock import SystemClock
    from merv_sandboxes.db import create_database
    from merv_sandboxes.providers.hub import ProviderHub
    from merv_sandboxes.providers.vault import Vault, load_key

    records = json.load(sys.stdin)
    settings = Settings.load()
    path = settings.data_dir / "vault.key"
    if not settings.vault_key and not path.is_file():
        raise SystemExit("existing native vault key is required")
    clock = SystemClock()
    database = create_database(settings.database_url)
    vault = Vault(database, clock, load_key(settings.vault_key, path))
    hub = ProviderHub(settings, vault, clock=clock)
    results = []
    try:
        for record in records:
            if not record["namespace"].startswith("merv-project-"):
                raise ValueError("provider import requires a Merv project namespace")
            if not record["enabled"]:
                raise ValueError(
                    "disabled provider requires an explicit namespace-disable policy"
                )
            # Check the plugin's credential schema in audit mode. Applying uses
            # the normal verified connect path before committing to the vault.
            plugin = hub._plugin(record["plugin"])
            plugin.auth.check(record["fields"], instance_name=record["name"])
            if apply:
                result = await hub.connect(
                    record["namespace"],
                    name=record["name"],
                    plugin_name=record["plugin"],
                    fields=record["fields"],
                    settings=record["settings"],
                    access=record["access"],
                )
                results.append(
                    {
                        "namespace": record["namespace"],
                        "name": record["name"],
                        "health": result.health.status.value,
                        "saved": True,
                    }
                )
            else:
                results.append(
                    {
                        "namespace": record["namespace"],
                        "name": record["name"],
                        "schema_checked": True,
                        "saved": False,
                    }
                )
        print(json.dumps(results))
    finally:
        await hub.close()
        await database.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    asyncio.run(run(parser.parse_args().apply))
