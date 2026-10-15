# Repository source read API

Audience: web and API implementers. Outcome: render authorized Git snapshots through Kumo and Pierre without widening permissions.

Status: local implementation and browser slice under [DEC-010](decisions.md#frontend-stack). Full handbook acceptance and Cloudflare provider qualification remain pending.

## Interfaces

| Read | Contract |
| --- | --- |
| Tree | Native `repo.tree`: GET tenant repository `/tree`, with ref, path, recursive, limit, direction and cursor from the preserved ForgeTreeQuery schema |
| Comparison | Native `repo.diff`: GET tenant repository `/diff`, with base, head, comparison, path_prefix, context_lines, limit, direction and cursor from ForgeDiffQuery |
| Source file | Additive GET `/api/v1/tenants/{tenant_id}/repositories/{id}/source-file?ref={commit_sha}&path={relative_path}` |

The file read fills a missing web contract for REQ-gfy-024. It is explicitly additive; the immutable 198-operation source catalog is unchanged. There is no new native source-file CLI/MCP tool claim. Tree and comparison use the existing public and private API operation paths.

Every read requires current `repository.read` authorization and tenant-qualified repository metadata. The source file endpoint requires a full lowercase 40-character commit OID. Paths must be relative, contain no parent traversal or NUL, and identify content within the repository snapshot.

## File response

| Field | Meaning |
| --- | --- |
| repository_id | Requested same-tenant repository ID |
| resolved_sha | Exact commit OID, equal to the requested immutable ref |
| path | Requested repository-relative path |
| sha | Exact Git object OID |
| size_bytes | Object byte size |
| encoding | utf-8, binary or unsupported |
| contents | UTF-8 source text, or null when unavailable as text |
| truncated | Whether the file exceeds the source read bound |

The web client checks repository, commit and path before rendering. Binary, unsupported and truncated content receives an explicit state. Source rendering does not execute Markdown, HTML, SVG or repository code.

## Snapshots and bounds

Tree and comparison initial requests resolve refs once. Signed continuation cursors bind tenant, repository, original query and exact commits; continuation uses the pinned objects even when a branch moves. Current authorization still applies on each request. Invalid cursors or changed queries fail explicitly.

The local Git adapter defaults to a 256 KiB file bound, 1 MiB diff bound and at most 1000 entries per page. Unsupported diff encoding is rejected; byte-truncated patches mark their files truncated. The web tree is capped at 10000 accumulated entries and exposes continuation/limit states. Comparison truncation and additional pages are visible; full large-data acceptance remains pending.

The local server reads real bare Git repositories through exact Git argv and metadata-backed path selection. The Worker adapter uses configured Artifacts capabilities and fails visibly when unsupported. Local success does not qualify a Cloudflare provider or production release.

## Verification

Source/API tests cover real Git objects, cursor scope and branch movement, unsafe paths, encoding and size bounds, denied grants, and public/private invocation. The browser fixture gate covers tree selection, source recovery, Pierre diff rendering, mobile file access, Escape/focus return and 390/320px page bounds. Fixtures are slice evidence.

Live browser captures and API read-back additionally compare the local example README bytes with independently read Git objects at the selected commit. Dependency locks and inventories identify the integrated Kumo/Pierre versions.

tl;dr: Kumo and Pierre present authorized, immutable source data through the existing API plus an explicit file-read supplement. Local proof is separate from complete product and provider acceptance.
