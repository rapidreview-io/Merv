import { MAX_ARTIFACT_IDS } from '@merv/contracts';
import type {
  Artifact,
  Artifacts,
  Caller,
  RunningUnitArtifact,
  Transaction,
} from '@merv/contracts';
import type { ProcessGraph } from '@merv/workflows/models';

/**
 * A unit's Artifacts tab, which Artifacts holds because every line of it is an artifact: the
 * files a unit's record names and those its sessions made, read in two statements, then listed
 * once each under the role its owner names (producer, reviewer, or none), at the stage the
 * record stood in when the file was made. The owner (Tasks, Experiments) says which ids are
 * whose; nothing here knows any program's states or review logic.
 */

/** Where the record stood at `at`: the state its last crossing before then led into. */
export function stageAt(graph: ProcessGraph, at: string): string {
  const crossings = graph.edges
    .flatMap((edge) =>
      edge.traversals.map((step) => ({ at: step.at, from: edge.from, to: edge.to })),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!crossings.length) return graph.state;
  return crossings.filter((step) => step.at < at).at(-1)?.to ?? crossings[0]!.from;
}

/** A file of the unit's, and the role of whoever made it where the owner knows it. */
export interface UnitFile {
  artifact: Pick<Artifact, 'id' | 'title' | 'mediaType' | 'size' | 'createdAt'>;
  role?: 'producer' | 'reviewer';
}

/**
 * The unit's files for its Artifacts tab, newest first: each listed once, under the role the
 * owner names first for it, at the stage the record stood in when the file was made.
 */
export function unitArtifacts(graph: ProcessGraph, files: readonly UnitFile[]) {
  const seen = new Map<string, UnitFile>();
  for (const file of files) if (!seen.has(file.artifact.id)) seen.set(file.artifact.id, file);
  return [...seen.values()]
    .sort(
      (a, b) =>
        b.artifact.createdAt.localeCompare(a.artifact.createdAt) ||
        b.artifact.id.localeCompare(a.artifact.id),
    )
    .map(({ artifact, role }): RunningUnitArtifact => ({
      id: artifact.id,
      title: artifact.title.slice(0, 200),
      mediaType: artifact.mediaType,
      size: artifact.size,
      at: artifact.createdAt,
      stage: stageAt(graph, artifact.createdAt),
      ...(role ? { role } : {}),
    }));
}

/** A unit's files as its sidebar read them: those its record names, and what its sessions made. */
export interface UnitFiles {
  found: ReadonlyMap<
    string,
    Pick<Artifact, 'id' | 'title' | 'mediaType'> & Partial<Pick<Artifact, 'size' | 'createdAt'>>
  >;
  made?: readonly UnitFile['artifact'][];
}

/** How many files a unit's sessions made its sidebar reads, newest first, in all. */
export const UNIT_MADE_LIMIT = 500;
/**
 * Reads a unit's files in the sidebar's transaction, in two statements: the first
 * MAX_ARTIFACT_IDS its record names, and the newest UNIT_MADE_LIMIT its sessions made.
 */
export async function unitFiles(
  artifacts: Pick<Artifacts, 'find' | 'list'>,
  caller: Caller,
  named: { ids: readonly string[]; sessions: readonly string[] },
  tx: Transaction,
): Promise<{ found: Map<string, Artifact>; made: Artifact[] }> {
  const found = await artifacts.find(caller, named.ids.slice(0, MAX_ARTIFACT_IDS), tx);
  const made = named.sessions.length
    ? await artifacts.list(caller, { sessions: named.sessions, limit: UNIT_MADE_LIMIT }, tx)
    : [];
  return { found, made };
}

/**
 * The unit's Artifacts tab from its files (`unitArtifacts`): what the system generated, which
 * is nobody's own even when a session made it or a reviewer cited it, then what its producer
 * handed in or made, then what its reviewers cited, then any other file its record names, such
 * as its brief. A file named twice is listed under the first of these.
 */
export function unitFileList(
  graph: ProcessGraph,
  files: UnitFiles,
  named: {
    generated?: readonly string[];
    producer: readonly string[];
    reviewer: readonly string[];
    other?: readonly string[];
  },
): RunningUnitArtifact[] {
  const file = (role?: UnitFile['role']) => (id: string) => {
    const artifact = files.found.get(id);
    const { size, createdAt } = artifact ?? {};
    return artifact && size !== undefined && createdAt
      ? [{ artifact: { ...artifact, size, createdAt }, ...(role ? { role } : {}) }]
      : [];
  };
  return unitArtifacts(graph, [
    ...(named.generated ?? []).flatMap(file()),
    ...named.producer.flatMap(file('producer')),
    ...(files.made ?? []).map((artifact): UnitFile => ({ artifact, role: 'producer' })),
    ...named.reviewer.flatMap(file('reviewer')),
    ...(named.other ?? []).flatMap(file()),
  ]);
}
