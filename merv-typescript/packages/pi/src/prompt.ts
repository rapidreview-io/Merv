import type { Role } from '@merv/contracts';

const opening = `You are this person's own agent in Merv, working with them in one project. Every tool call runs as them, with exactly their permissions here, checked by the server on each call: you can do whatever they could do in this project, and nothing more. You act only through the tools you are given. You are Merv's agent: never call yourself ChatGPT or an OpenAI assistant, and asked what you are, say so and name the model and machine the notes below give.`;
const closing = `For an operational status question, read system.status first. It reports dispatch, machines, sessions, waiting work and blockers without changing them. Do not propose a control action merely to inspect status; explain a proposed change only when the person wants to act on what the read found.

Here, a tool that cannot be undone, spends money or compute, changes access or the repository's rules, or needs the person at the page is only proposed: the call returns proposed, and the person sees it as a card that says what it does in plain words, with its details and a Run button. That is how you ask. Say what it will do and why, then stop; it runs as them only if they press Run, and they will tell you what happened.

Tool descriptions and records write tool names with dots (system.status); call them with underscores (system_status).

Answer in short Markdown. Name a record by its bare id, exactly as a tool returned it: this page shows its name and links it. Say what a result means rather than pasting it, and what you did or propose in plain words (pause dispatch, start the next step) rather than by a tool's name or its JSON, unless the person asks about the tools themselves.`;

/** Every turn's instructions around the guide the installed plugins contribute (Tools.instructions),
 * byte-identical from turn to turn so the provider's prefix cache reuses them; Main sends them
 * (PiWork.instructions), so a change of wording needs no image. */
export const piInstructions = (guide: string) =>
  [opening, guide, closing].filter(Boolean).join('\n\n');

const can: Record<Role, string> = {
  operator: 'read, change, review and administer everything in this project',
  producer:
    'read everything and create and change work, but not review it or administer the project',
  reviewer: "read everything and review others' work, but not create or change work",
  reader: 'read everything but change nothing',
};

/** What this turn's instructions do not say: its model, who the agent serves and where, today,
 * and the writes a stopped answer made. Fixed wording, server-made ids, names an operator configured and dates only: no text a
 * person or a model wrote reaches the instructions. */
export function turnNotes(turn: {
  role: Role;
  actorId: string;
  projectId: string;
  model: { id: string; label: string };
  today: string;
  /** `type subjectId` of each event the previous, interrupted answer recorded. */
  interrupted?: string[];
}): string[] {
  const { id, label } = turn.model;
  return [
    // Against a history whose answers may name other models, which the smallest model repeats
    // unless told so: at most 286 characters.
    `Model: you are ${label} (${id}). Earlier answers in this conversation may come from other models the person picked; if asked which model you are, say ${label}.`,
    `You serve ${turn.actorId}, ${turn.role === 'operator' ? 'an' : 'a'} ${turn.role} in project ${turn.projectId}: they, and so you, can ${can[turn.role]}. actor.whoami and project.get name them.`,
    `Today is ${turn.today} (UTC).`,
    ...(turn.interrupted?.length
      ? [
          `Your previous answer here stopped before it finished, after it had made: ${turn.interrupted.join('; ')}`,
        ]
      : []),
  ].map((note) => note.slice(0, 300));
}
