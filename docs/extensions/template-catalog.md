# Template catalog and community contributions

SemaFrame's template catalog is a signed, static index. Each entry points to a safe catalog-relative JSON artifact and pins the artifact's lowercase SHA-256 digest. The catalog envelope is verified with an operator-pinned Ed25519 public key before any entry is shown or cached.

## Trust and cache rules

The runtime rejects unknown fields, duplicate `id@version` entries, unsafe paths, untrusted key IDs, invalid signatures, expired catalogs, validity windows longer than 31 days, and sequence rollback. A verified catalog may be used from cache without revalidation for one hour. When offline, an older verified copy may be used only until its signed `expiresAt`; expired content is never used as a fallback.

Cache records are created only from the in-process verification evidence returned by `verifyStaticTemplateCatalog`; caller-constructed or deserialized records are treated as unverified and require a fetch/reverification. Persist the signed catalog envelope, not a claimed "verified" cache record, and run verification again after reload.

Artifact bytes are hashed before UTF-8 decoding or JSON parsing. The parsed descriptor's ID, kind, and version must exactly match the signed catalog entry.

## Descriptor rules

There are two kinds:

- `project` proposes a new Workspace and an atomic revision-zero transaction.
- `model` proposes an atomic transaction against a caller-supplied Workspace revision.

Both use ordinary Workspace Protocol operations. Planning returns data with `authorization.status = "not_granted"`. It does not create a project, mutate a Store, contact a catalog, or grant permissions. The host must show the proposal, obtain user confirmation, authorize the explicit permissions, and submit it through the normal revision-bound transaction path.

Planning also requires the current application version and refuses a descriptor whose `minimumAppVersion` is newer under SemVer precedence.

Community descriptors must use semantic versions, an SPDX license identifier, bounded text, deterministic IDs and placements, no wildcard permission, no executable installation hook, and no more than 100 operations. `requiredPermissions` must cover every declared operation.

Schemas and runtime entry points:

- `src/ecosystem/catalog/staticTemplateCatalog.schema.json`
- `src/ecosystem/catalog/templateDescriptor.schema.json`
- `parseStaticTemplateCatalog` / `verifyStaticTemplateCatalog`
- `parseCatalogTemplateArtifact`
- `planProjectTemplateInstallation` / `planModelTemplateInstallation`

First-party descriptors live in `src/ecosystem/templates/firstPartyTemplates.ts` and pass the same parser as community submissions.
