# Boring Bot: Repository Aggregation System

## Purpose

Build a system that aggregates repository metadata across GitHub, GitLab, and Bitbucket into a unified data store. The goal is visibility: a single source of truth for what repositories an organization owns, where they live, and what technologies they use.

## Scope

### Build Now (V1)

- Three provider adapters (GitHub, GitLab, Bitbucket)
- Polling-based sync with rate limiting
- Single database table for repositories
- Unified grouping via `group_path` field (normalized from provider hierarchy)
- Filter and search API
- Language and provider aggregation endpoints

### Deferred (Future)

- Webhook-based real-time sync
- Monorepo detection and component tracking
- Manual organizational metadata (team ownership, cost centers, compliance tags)
- Activity level calculations
- Configurable grouping dimensions
- Additional providers (Azure DevOps, etc.)

---

## Provider Hierarchy Comparison

Each provider structures repositories differently. Boring Bot normalizes these into a unified `group_path`.

| Level | GitHub | GitLab | Bitbucket |
|-------|--------|--------|-----------|
| **Top** | Organization | Group | Workspace |
| **Middle** | — | Subgroup (unlimited nesting) | Project |
| **Bottom** | Repository | Project (repo) | Repository |
| **Depth** | 2 levels | Unlimited | 3 levels |

### GitHub Structure
```
Organization
  └── Repository
  └── Repository
```
Flat structure. Repositories live directly under an organization. Teams exist for permissions but do not organize repositories.

### GitLab Structure
```
Group
  └── Subgroup
        └── Subgroup (can nest infinitely)
              └── Project (repo)
  └── Project (repo)
```
Deepest hierarchy. Subgroups can nest arbitrarily, producing paths like `company/platform/backend/auth-service`.

### Bitbucket Structure
```
Workspace
  └── Project
        └── Repository
        └── Repository
  └── Project
        └── Repository
```
Strict 3-level hierarchy. Workspaces contain Projects, Projects contain Repositories. Projects cannot nest inside other projects.

### Normalization to `group_path`

The `group_path` field captures the container hierarchy above the repository:

| Provider | Native Path | `group_path` | `fullName` |
|----------|-------------|--------------|------------|
| GitHub | `myorg/api-service` | `myorg` | `myorg/api-service` |
| GitLab | `myorg/platform/backend/api-service` | `myorg/platform/backend` | `myorg/platform/backend/api-service` |
| Bitbucket | `myworkspace/platform-project/api-service` | `myworkspace/platform-project` | `myworkspace/platform-project/api-service` |

This preserves GitLab's deeper structure, gives Bitbucket its project grouping, and keeps GitHub at the org level.

---

## Data Model

```typescript
interface Repository {
  // Identity
  id: string;                              // Internal ID, format: "{provider}:{providerRepoId}"
  provider: 'github' | 'gitlab' | 'bitbucket';
  providerRepoId: string;                  // Original ID from provider
  fullName: string;                        // Full path: "org/repo" or "group/subgroup/repo"
  url: string;                             // Web URL to repository

  // Grouping (auto-populated from provider hierarchy)
  groupPath: string;                       // Container path above repo (see normalization table)

  // Metadata (auto-populated from provider APIs)
  description: string | null;
  languages: Record<string, number>;       // e.g., { "Python": 65, "JavaScript": 35 }
  defaultBranch: string;
  visibility: 'public' | 'internal' | 'private';
  isArchived: boolean;
  createdAt: Date;
  lastPushAt: Date;

  // Sync tracking
  lastSyncAt: Date;
}
```

---

## Database Schema

Use PostgreSQL for production. SQLite acceptable for development.

```sql
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_repo_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  url TEXT NOT NULL,
  group_path TEXT NOT NULL,
  description TEXT,
  languages JSONB NOT NULL DEFAULT '{}',
  default_branch TEXT,
  visibility TEXT NOT NULL,
  is_archived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP,
  last_push_at TIMESTAMP,
  last_sync_at TIMESTAMP NOT NULL,

  UNIQUE(provider, provider_repo_id)
);

CREATE INDEX idx_repos_provider ON repositories(provider);
CREATE INDEX idx_repos_visibility ON repositories(visibility);
CREATE INDEX idx_repos_group_path ON repositories(group_path);
CREATE INDEX idx_repos_languages ON repositories USING GIN(languages);
CREATE INDEX idx_repos_full_name ON repositories(full_name);
```

### Querying by Group Path

Use prefix matching to find all repos under a group:

```sql
-- All repos under "myorg/platform" (GitLab subgroup or Bitbucket project)
SELECT * FROM repositories WHERE group_path LIKE 'myorg/platform%';

-- All repos in a specific group (exact match)
SELECT * FROM repositories WHERE group_path = 'myorg/platform/backend';

-- Group by top-level org/workspace
SELECT split_part(group_path, '/', 1) as org, COUNT(*) 
FROM repositories 
GROUP BY org;
```

---

## Provider Adapters

Each adapter implements this interface:

```typescript
interface ProviderAdapter {
  listRepositories(org: string): Promise<RawRepo[]>;
  getLanguages(org: string, repo: string): Promise<Record<string, number>>;
  extractGroupPath(raw: RawRepo): string;  // Extract container path from raw response
  requestDelayMs: number;                   // Minimum ms between requests
}
```

### Provider-Specific Details

| Provider   | Rate Limit   | Org Concept       | Languages Endpoint | Auth Methods          |
|------------|--------------|-------------------|--------------------|-----------------------|
| GitHub     | 5,000/hr     | Organization      | Separate endpoint  | PAT, GitHub App       |
| GitLab     | 2,000/min    | Group (can nest)  | In project response| PAT, OAuth            |
| Bitbucket  | 1,000/hr     | Workspace         | Separate endpoint  | App passwords, OAuth  |

### Hierarchy Traversal

**GitHub**: Flat traversal. Call `GET /orgs/{org}/repos` to list all repos in the org.

**GitLab**: Recursive traversal required. Groups can contain subgroups indefinitely.
```
1. List all projects in group: GET /groups/{id}/projects
2. List all subgroups: GET /groups/{id}/subgroups
3. Recursively process each subgroup
```
The `path_with_namespace` field gives you the full path (e.g., `myorg/platform/backend/api-service`).

**Bitbucket**: Two-level traversal. List projects in workspace, then repos in each project.
```
1. List projects: GET /workspaces/{workspace}/projects
2. For each project, list repos: GET /repositories/{workspace}?q=project.key="{project_key}"
```
Combine workspace slug and project key for `group_path`.

### Normalization

Each provider needs a normalize function:

```typescript
// GitHub
function normalizeGitHubRepo(raw: GitHubRepo, languages: Record<string, number>): Repository {
  const orgName = raw.full_name.split('/')[0];
  return {
    id: `github:${raw.id}`,
    provider: 'github',
    providerRepoId: String(raw.id),
    fullName: raw.full_name,                    // "myorg/api-service"
    groupPath: orgName,                          // "myorg"
    url: raw.html_url,
    description: raw.description,
    languages,
    defaultBranch: raw.default_branch,
    visibility: raw.visibility,
    isArchived: raw.archived,
    createdAt: new Date(raw.created_at),
    lastPushAt: new Date(raw.pushed_at),
    lastSyncAt: new Date(),
  };
}

// GitLab
function normalizeGitLabProject(raw: GitLabProject): Repository {
  // raw.path_with_namespace = "myorg/platform/backend/api-service"
  const pathParts = raw.path_with_namespace.split('/');
  const groupPath = pathParts.slice(0, -1).join('/');  // "myorg/platform/backend"
  
  return {
    id: `gitlab:${raw.id}`,
    provider: 'gitlab',
    providerRepoId: String(raw.id),
    fullName: raw.path_with_namespace,
    groupPath,
    url: raw.web_url,
    description: raw.description,
    languages: raw.languages || {},              // GitLab includes this in project response
    defaultBranch: raw.default_branch,
    visibility: raw.visibility,
    isArchived: raw.archived,
    createdAt: new Date(raw.created_at),
    lastPushAt: new Date(raw.last_activity_at),
    lastSyncAt: new Date(),
  };
}

// Bitbucket
function normalizeBitbucketRepo(
  raw: BitbucketRepo, 
  workspace: string, 
  projectKey: string,
  languages: Record<string, number>
): Repository {
  return {
    id: `bitbucket:${raw.uuid}`,
    provider: 'bitbucket',
    providerRepoId: raw.uuid,
    fullName: `${workspace}/${projectKey}/${raw.slug}`,
    groupPath: `${workspace}/${projectKey}`,
    url: raw.links.html.href,
    description: raw.description,
    languages,
    defaultBranch: raw.mainbranch?.name || 'main',
    visibility: raw.is_private ? 'private' : 'public',
    isArchived: false,                           // Bitbucket doesn't have archive concept
    createdAt: new Date(raw.created_on),
    lastPushAt: new Date(raw.updated_on),
    lastSyncAt: new Date(),
  };
}
```

---

## Sync Engine

### Configuration

```typescript
interface SyncJob {
  provider: 'github' | 'gitlab' | 'bitbucket';
  credentials: ProviderCredentials;
  organizations: string[];      // Orgs/groups/workspaces to sync
  intervalMinutes: number;      // Recommended: 15-30
}
```

### Sync Loop

```typescript
async function syncProvider(job: SyncJob): Promise<void> {
  const adapter = getAdapter(job.provider);
  await adapter.authenticate(job.credentials);

  for (const org of job.organizations) {
    const repos = await adapter.listRepositories(org);

    for (const repo of repos) {
      const languages = await adapter.getLanguages(org, repo.name);
      const normalized = normalize(job.provider, repo, languages);
      await upsertRepository(normalized);

      // Respect rate limits
      await sleep(adapter.requestDelayMs);
    }
  }
}
```

### Upsert Logic

Insert or update based on `(provider, provider_repo_id)` unique constraint. Always update `last_sync_at` on every sync.

---

## Query API

### Interface

```typescript
interface RepoFilters {
  providers?: string[];
  languages?: string[];
  visibility?: string[];
  groupPath?: string;           // Exact match or prefix match with trailing *
  search?: string;              // Searches name and description
  includeArchived?: boolean;    // Default: false
}

class Repositories {
  // Core queries
  async listRepos(filters?: RepoFilters): Promise<Repository[]>;
  async getRepo(provider: string, fullName: string): Promise<Repository | null>;

  // Aggregations
  async countByProvider(): Promise<Record<string, number>>;
  async countByLanguage(): Promise<Record<string, number>>;
  async countByGroupPath(depth?: number): Promise<Record<string, number>>;

  // Sync management
  async triggerSync(provider?: string): Promise<void>;
  async getSyncStatus(): Promise<SyncStatus[]>;
}
```

### Query Implementation Notes

- `languages` filter: Use JSONB containment (`languages ? 'Python'`) to find repos containing a language
- `groupPath` filter:
    - Exact match: `groupPath = 'myorg/platform'`
    - Prefix match: `groupPath LIKE 'myorg/platform%'` (when filter ends with `*`)
- `search` filter: Use `ILIKE` on `full_name` and `description`
- `countByLanguage`: Requires extracting keys from JSONB and aggregating across all rows
- `countByGroupPath(depth)`: Split `group_path` and group by first N segments

---

## Implementation Checklist

### Phase 1: Core Infrastructure

- [ ] Set up database with repositories table and indexes
- [ ] Implement Repository type definitions
- [ ] Create normalization utility functions
- [ ] Define ProviderAdapter interface

### Phase 2: Provider Adapters

- [ ] GitHub adapter
    - [ ] Authentication (PAT or GitHub App)
    - [ ] `listRepositories` with pagination
    - [ ] `getLanguages` endpoint
    - [ ] `extractGroupPath` (org name from `full_name`)
    - [ ] Rate limit handling (5,000/hr)
- [ ] GitLab adapter
    - [ ] Authentication
    - [ ] Recursive group/subgroup traversal
    - [ ] Extract languages from project response
    - [ ] `extractGroupPath` (from `path_with_namespace`)
    - [ ] Rate limit handling (2,000/min)
- [ ] Bitbucket adapter
    - [ ] Authentication (app password)
    - [ ] List projects in workspace
    - [ ] List repos per project
    - [ ] `getLanguages` endpoint
    - [ ] `extractGroupPath` (workspace/project)
    - [ ] Rate limit handling (1,000/hr)

### Phase 3: Sync Engine

- [ ] Sync job configuration storage
- [ ] Sync loop with rate limit delays
- [ ] Upsert logic with conflict resolution
- [ ] Sync status tracking (last run, errors, repo count)
- [ ] Scheduled job runner (cron or interval-based)

### Phase 4: Query API

- [ ] `listRepos` with filter support (including `groupPath` prefix matching)
- [ ] `getRepo` by provider and fullName
- [ ] `countByProvider` aggregation
- [ ] `countByLanguage` aggregation
- [ ] `countByGroupPath` aggregation with depth parameter
- [ ] `triggerSync` manual trigger
- [ ] `getSyncStatus` endpoint

---

## Extension Points

The V1 architecture supports these future additions without restructuring:

| Feature | How to Add |
|---------|------------|
| Webhooks | Add webhook receiver that calls same `upsertRepository` function |
| Monorepo support | Add `is_monorepo` boolean and `components` JSONB column |
| Organizational metadata | Add columns: `tags`, `owner_team`, `cost_center`, `compliance_level` |
| New providers | Implement ProviderAdapter interface with same 3 methods |
| Activity tracking | Add computed column or calculate at query time from `last_push_at` |
| Custom groupings | Extend query interface when real use cases emerge |

---

## Decisions Log

| Decision | Rationale |
|----------|-----------|
| Polling over webhooks | Avoids operational complexity (public endpoints, registration, verification). Repository metadata changes infrequently; 15-30 min polling is sufficient for visibility use case. |
| Single table | No need for normalized schema at this scale. JSONB handles flexible language data. Simpler queries. |
| Unified `group_path` field | Providers have different hierarchy depths (GitHub: 1 level, Bitbucket: 2 levels, GitLab: unlimited). A single path string normalizes these differences and enables prefix-based queries across all providers. |
| No monorepo detection in V1 | Requires cloning repos or deep file tree analysis. Significant complexity for edge case. Can add later. |
| No manual metadata in V1 | Focus on auto-populated data first. Manual fields require UI and workflows to maintain. |
| Provider-specific normalizers | Each provider's API differs significantly. Explicit mapping functions are clearer than generic transformation. |
| GitLab recursive traversal | GitLab's unlimited subgroup nesting requires recursive API calls. This is more complex than GitHub/Bitbucket but necessary to capture full hierarchy. |