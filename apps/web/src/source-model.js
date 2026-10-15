const endpoints = new Set(['tree', 'diff', 'source-file']);
const enc = encodeURIComponent;

export function sourceUrl(tenant, repository, endpoint, query) {
  if (!endpoints.has(endpoint)) throw new Error('Unsupported source endpoint');
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null));
  const root = '/api/v1/tenants/' + enc(tenant) + '/repositories/' + enc(repository);
  const path = endpoint === 'source-file' ? root + '/source-file' : root + '/' + endpoint;
  return path + '?' + params;
}

export function sourceText(content, repository, commit, path) {
  if (content.repository_id !== repository || content.resolved_sha !== commit || content.path !== path) {
    throw new Error('Source response does not match the selected snapshot.');
  }
  if (content.encoding !== 'utf-8' || content.truncated) return null;
  if (typeof content.contents !== 'string') throw new Error('Source response has no text content.');
  return content.contents;
}

export function diffPatch(file) {
  if (file.binary || file.truncated) return null;
  const oldName = file.old_path === null ? '/dev/null' : JSON.stringify('a/' + file.old_path);
  const newName = file.new_path === null ? '/dev/null' : JSON.stringify('b/' + file.new_path);
  const name = file.new_path || file.old_path;
  let patch = 'diff --git ' + JSON.stringify('a/' + (file.old_path || name)) + ' ' + JSON.stringify('b/' + (file.new_path || name)) + '\n';
  patch += '--- ' + oldName + '\n+++ ' + newName + '\n';
  for (const hunk of file.hunks) {
    patch += '@@ -' + hunk.old_start + ',' + hunk.old_count + ' +' + hunk.new_start + ',' + hunk.new_count + ' @@\n';
    for (const line of hunk.lines) {
      const prefix = { context: ' ', addition: '+', deletion: '-' }[line.kind];
      if (!prefix || /[\r\n]/.test(line.text)) throw new Error('Invalid diff line.');
      patch += prefix + line.text + '\n';
      if (!line.has_newline) patch += '\\ No newline at end of file\n';
    }
  }
  return patch;
}
