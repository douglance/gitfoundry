import type { ForgeGitPort } from "@gitfoundry/core";

export async function collaborationOnlyState(git: Pick<ForgeGitPort, "listTree">, expectedState: string, candidateState: string): Promise<boolean> {
  const [beforeEntries, afterEntries] = await Promise.all([git.listTree(expectedState), git.listTree(candidateState)]);
  const before = new Map(beforeEntries.map(entry => [entry.path, entry]));
  const after = new Map(afterEntries.map(entry => [entry.path, entry]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter(path => {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    return oldEntry?.oid !== newEntry?.oid || oldEntry?.mode !== newEntry?.mode || oldEntry?.type !== newEntry?.type;
  });
  return changed.length > 0 && changed.every(path => {
    if (!/^(issues|comments)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(path)) return false;
    return [before.get(path), after.get(path)].every(entry => !entry || entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"));
  });
}
