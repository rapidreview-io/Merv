"""Public workflow operations and the optional bindings for existing records."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Protocol

from ..kernel.state.store import BaseStateStore, Connection
from ..kernel.utils import NotFoundError
from .graph import Data, Knowledge, Program, Registry, Snapshot
from .delivery import Deliveries
from .runtime import CommitRecord, CreateRecord, EmptyKnowledge, KnowledgeFactory, Runtime, TransactionalHandler, snapshot_view
from .persistence import WORKFLOW_SCHEMA


class PrepareTransition(Protocol):
    def __call__(self, snapshot: Snapshot, action: str, payload: Data) -> None: ...


@dataclass(frozen=True, slots=True)
class Binding:
    knowledge: KnowledgeFactory
    commit: CommitRecord
    create: CreateRecord


class CombinedKnowledge:
    def __init__(self, local: Knowledge, common: Knowledge) -> None:
        self.local, self.common = local, common

    def read(self, reference):
        try:
            return self.local.read(reference)
        except NotFoundError:
            return self.common.read(reference)


class Workflows:
    def __init__(
        self, *, store: BaseStateStore, programs: Iterable[Program],
        bindings: Mapping[str, Binding] | None = None,
        knowledge: KnowledgeFactory | None = None,
    ) -> None:
        programs = tuple(programs)
        self._transactional = {name: {(workflow.name, workflow.version)
                              for program in programs if name in program.transactional_effects
                              for workflow in program.workflows}
                              for program in programs for name in program.transactional_effects}
        store.install(WORKFLOW_SCHEMA)
        self.bindings = dict(bindings or {})
        self.preparations: dict[str, PrepareTransition] = {}
        self.deliveries = Deliveries(store=store)
        self._knowledge = knowledge or (lambda snapshot, conn: EmptyKnowledge())
        self.runtime = Runtime(
            store=store, registry=Registry(workflow for program in programs for workflow in program.workflows),
            knowledge=self._read, commit=self._commit, create=self._create,
        )

    def register_transactional_effect(self, name: str, handler: TransactionalHandler) -> None:
        if name not in self._transactional or not callable(handler):
            raise ValueError(f"undeclared transactional effect or invalid handler: {name!r}")
        keys = [(workflow, version, name) for workflow, version in self._transactional[name]]
        if any(key in self.runtime.transactional_effects for key in keys):
            raise ValueError(f"transactional effect {name!r} already registered")
        self.runtime.transactional_effects.update((key, handler) for key in keys)

    def _read(self, snapshot, conn):
        binding = self.bindings.get(snapshot.workflow)
        common = self._knowledge(snapshot, conn)
        return common if binding is None else CombinedKnowledge(binding.knowledge(snapshot, conn), common)

    def bind(self, workflow: str, binding: Binding) -> None:
        self.runtime.registry.get(workflow)
        if workflow in self.bindings:
            raise ValueError(f"workflow {workflow!r} already has a record binding")
        self.bindings[workflow] = binding

    def _commit(self, conn, before, after, action, payload):
        binding = self.bindings.get(before.workflow)
        if binding is not None:
            binding.commit(conn, before, after, action, payload)

    def _create(self, conn, snapshot):
        binding = self.bindings.get(snapshot.workflow)
        if binding is not None:
            binding.create(conn, snapshot)

    def catalog(self):
        return {"workflows": self.runtime.registry.catalog()}

    def start(self, **kwargs):
        return snapshot_view(self.runtime.start(**kwargs))

    def transition(self, **kwargs):
        replay = self.runtime.replay_action(**kwargs)
        if replay is not None:
            return snapshot_view(replay)
        snapshot = self.runtime.get(project_id=kwargs["project_id"], instance_id=kwargs["instance_id"])
        preparation = self.preparations.get(snapshot.workflow)
        if preparation is not None and snapshot.revision == kwargs["expected_revision"]:
            definition = self.runtime.registry.get(snapshot.workflow, snapshot.version)
            if any(edge.source == snapshot.state and edge.name == kwargs["action"] for edge in definition.edges):
                preparation(snapshot, kwargs["action"], kwargs.get("payload") or {})
        return snapshot_view(self.runtime.apply(**kwargs))

    def register_preparation(self, workflow: str, preparation: PrepareTransition) -> None:
        self.runtime.registry.get(workflow)
        if workflow in self.preparations:
            raise ValueError(f"workflow {workflow!r} already has a preparation")
        self.preparations[workflow] = preparation

    def status(self, *, project_id: str, instance_id: str):
        return self.runtime.evaluate(project_id=project_id, instance_id=instance_id).public()

    def describe(self, *, project_id: str, instance_id: str):
        return self.runtime.describe(project_id=project_id, instance_id=instance_id)

    def assignment(self, *, project_id: str, instance_id: str):
        return self.runtime.assignment(project_id=project_id, instance_id=instance_id)

    def candidates(self, *, project_id: str):
        return self.runtime.candidates(project_id=project_id)

    def activate(self, **kwargs):
        return self.runtime.activate(**kwargs)

    def begin(self, *, project_id: str, instance_id: str, expected_revision: int):
        """Start an interactive assignment without creating another graph state."""
        with self.runtime.store.transaction() as conn:
            self.runtime.activate(
                conn=conn, project_id=project_id, instance_id=instance_id,
                revision=expected_revision, session_id="interactive",
            )
            return self.runtime.assignment(conn=conn, project_id=project_id, instance_id=instance_id)

    def history(self, *, project_id: str, instance_id: str):
        return {
            "history": self.runtime.history(project_id=project_id, instance_id=instance_id),
            "actions": self.deliveries.history(project_id=project_id, instance_id=instance_id),
        }
