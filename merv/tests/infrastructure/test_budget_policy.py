import unittest
"""Merv carries identity and requests, not infrastructure policy authority."""
import inspect

from merv.brain.infrastructure.client import InfrastructureClient
from merv.brain.infrastructure.providers import RemoteProviders


class BudgetPolicyTests(unittest.TestCase):

    def test_transport_has_no_caller_supplied_budget_parameter(self):
        assert "budget" not in inspect.signature(InfrastructureClient.request).parameters

    def test_provider_adapter_has_no_administration_methods(self):
        for operation in ("set_enabled", "set_daily_limit", "set_credentials", "disconnect"):
            assert not hasattr(RemoteProviders, operation)
