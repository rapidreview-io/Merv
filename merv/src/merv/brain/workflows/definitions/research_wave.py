"""A published reflection composes its exact experiment/task wave once."""

from ..composition import Child, join_guard
from ..graph import Change, Edge, Node, Reference, Workflow


def _children(snapshot, knowledge):
    reflection = knowledge.read(Reference("reflection", str(snapshot.data["reflection_id"])))
    return tuple(
        Child(key=f"{kind}:{item.get('proposal_key') or item[f'{kind}_id']}", workflow=kind,
              instance_id=str(item[f"{kind}_id"]))
        for kind, records in (("experiment", reflection["materialized_experiments"]),
                              ("task", reflection["materialized_tasks"]))
        for item in records
    )


def _join(snapshot, knowledge):
    if not snapshot.children or any(not child.outcome for child in snapshot.children):
        return None
    return "complete" if all(child.outcome == "completed" for child in snapshot.children) else "replan"


def _next_reflection(snapshot, payload, knowledge):
    return Change(data={"outcomes": {child.key: child.outcome for child in snapshot.children},
                        "next_workflow": "reflection",
                        "next_step": "Create a reflection over the completed wave and its retained evidence when the project is ready."})


RESEARCH_WAVE = Workflow(
    name="research_wave", version=1, initial="working",
    nodes=(Node("working", "Wait for the published experiment and task wave", children=_children, join=_join),),
    edges=(
        Edge("working", "complete", "completed", check=join_guard(_join, "complete"), change=_next_reflection,
             label="The whole wave completed; reflect on its evidence"),
        Edge("working", "replan", "needs_replanning", check=join_guard(_join, "replan"), change=_next_reflection,
             label="The settled wave includes unsuccessful work; revisit the plan in reflection"),
    ),
    outcomes={"completed": "completed", "needs_replanning": "needs_replanning"},
)
