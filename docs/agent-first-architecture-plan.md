# Agent-first Architecture Plan

> **Status: implemented architecture record.**
>
> This document preserves the migration rationale and acceptance criteria that
> led to the current Agent-first model. It is not a live API or schema
> reference. For current behavior use `CLAUDE.md`, `docs/API.md`,
> `src/channel-mount-service.ts`, and `src/db.ts`. Sections named “Current
> Findings” describe the state at the time of the migration unless they
> explicitly say otherwise.

## Executive Summary

The migration established an Agent-first product surface while retaining compatibility with the
existing group/session runtime. The product model and the persisted runtime model remain
explicitly distinct:

- Agent is the top-level product identity and policy owner.
- Workspace is the private filesystem, routing, and host/container isolation boundary owned by its creator.
- Runtime session is an execution record inside a workspace; it is not another product-level Agent.

The correct target hierarchy is:

```text
Agent
  - identity prompt
  - Claude preset inclusion policy
  - user Skill / user MCP policy（Provider 与凭据由系统统一管理）
  - channel mounts
  - workspaces
      - runtime isolation boundary
      - main session
      - optional conversation/task runtime sessions
```

The highest-risk migration point is runtime identity consistency. A warm runner captures
`containerInput.agentProfile` at process start. If the Agent prompt or preset policy changes,
or if a workspace switches to a different Agent, IPC-injected messages can still be processed
by the old in-memory runner. This must be fixed before deeper schema migration.

## Current Findings

### Backend

- `agent_profiles` already represents the new top-level Agent identity.
- `workspace_agent_profiles` maps a workspace folder to an AgentProfile.
- The container runner already receives Agent identity metadata and injects it into the
  system prompt.
- Session identity metadata is already stored and checked through profile id/hash/version.
- `workspaces`, `workspace_runtime_sessions`, and `agent_channel_mounts` are the canonical
  compatibility mirrors exposed by `/api/workspaces`.
- `registered_groups` and legacy session/channel fields remain write-through compatibility state;
  parity tests are required until every reader has migrated.
- The old `agents` table is still the conversation/task/spawn-agent model, not the new
  top-level Agent concept.
- Agent runtime policy filters enabled user Skills and user MCP servers. Project, external, and
  plugin Skills are not selected by that policy. Agent tools themselves remain fully available.

### Frontend

- Desktop and mobile navigation preserve `Agent -> Workspace` grouping for the creator's home,
  pinned, and additional workspaces; the home workspace displays its actual Agent.
- Workspace creation requires an explicitly loaded and selected Agent. A failed Agent request
  is an error state, never an implicit default selection.
- Agent governance shows workspaces, runtime sessions, and channel mounts. A workspace can be
  migrated explicitly, and deleting a non-default Agent requires pre-migration.
- Runtime-policy editors use the live user Skill and user MCP catalogs rather than free-form
  identifiers. Provider selection is not part of Agent policy.
- The effective-capability preview resolves host, CommerceAgent-managed, and workspace project layers,
  and reports name conflicts before execution.
- Agent and IM load failures are distinct from valid empty states and expose retry actions.

## Target Domain Model

### Agent

Agent is the product-level actor.

Fields:

- `id`
- `owner_user_id`
- `name`
- `identity_prompt`
- `include_claude_preset`
- `runtime_policy` (user Skill policy, user MCP policy, context policy；不包含 Provider)
- `identity_hash`
- `version`
- `status`
- `is_default`

Future fields:

- channel mount policy
- default workspace template

### Workspace

Workspace is an isolation boundary derived from an Agent.

Responsibilities:

- filesystem isolation
- host or container execution mode
- main session
- runtime metadata
- optional linked IM/web channels

Compatibility mapping:

- existing `registered_groups.folder` is the workspace id/folder key for now.
- existing `workspace_agent_profiles` is the bridge from workspace to Agent.
- canonical `workspaces` records mirror the compatibility row and expose Agent/runtime/mount
  summaries through `/api/workspaces`.

### Runtime Session

Each workspace has one main session by default.

Additional runtime sessions can exist for:

- spawned sub-agents
- scheduled tasks
- channel-specific conversations, when needed

Runtime-session identity must include:

- AgentProfile id
- identity hash
- version

### Channel Mount

A channel is an external message entry point. In the target model it is mounted under an Agent,
then routed to a workspace/session.

Canonical compatibility table:

```text
agent_channel_mounts
  - channel_jid
  - owner_user_id
  - agent_profile_id
  - channel_type
  - workspace_jid / workspace_folder
  - session_id
  - routing_mode
  - reply_policy
  - activation_mode / owner_im_id
```

Compatibility:

- Existing `registered_groups.target_agent_id`, `target_main_jid`, and `reply_policy` remain the
  routing source of truth during migration.
- `agent_channel_mounts` is synchronized on bind/unbind, workspace migration, workspace deletion,
  and startup repair. Workspace-to-Agent reassignment updates the profile mapping and mount mirror
  in one database transaction.

## Prompt Composition Semantics

Agent identity should be a first-class prompt layer.

If `include_claude_preset = true`:

```text
Claude Code preset
+ Agent identity prompt
+ workspace/context prompt
+ message history
```

If `include_claude_preset = false`:

```text
Agent identity prompt
+ workspace/context prompt
+ message history
```

This switch is user-controlled when creating or editing an Agent.

## Migration Plan

### Phase 0: Runtime Consistency

Goal: any Agent identity change must not leak into a warm runner with stale prompt state.

Status: implemented in this branch; update failures must still remain observable and retryable.

Implementation:

- When an Agent identity prompt or Claude preset switch changes, stop all warm runners for
  workspaces currently attached to that Agent.
- When a workspace switches to another Agent, stop all warm runners for that workspace.
- Do not eagerly delete session rows in this path. The existing session identity mismatch
  checks should perform the reset on the next cold run and preserve the existing recent-history
  injection behavior.

### Phase 1: Agent-first Product Surface

Goal: make Agent the first-level user mental model.

Status: implemented for navigation, creation, assignment governance, and deletion migration.

Implementation:

- Sidebar exposes Agent management as a primary item.
- Workspaces are displayed under their owning Agent in home, pinned, and personal lists.
- Workspace creation requires an explicit Agent selection after the catalog loads successfully.
- Agent governance is the explicit assignment surface: it lists workspace/runtime/mount ownership,
  supports migration, and requires migration before deleting a non-default Agent.

### Phase 2: Workspace Compatibility Schema

Goal: introduce explicit workspace tables without breaking existing data.

Status: canonical read mirrors and compatibility backfill are implemented; legacy write-through
remains until all runtime readers migrate.

Implementation:

- Use `workspaces` as the canonical workspace metadata table.
- Backfill from web `registered_groups`.
- Keep writing `registered_groups` for compatibility until all readers move.
- Use `workspace_runtime_sessions` for runtime identity snapshots. API names are
  `runtime_sessions`, `runtime_session_count`, and `/api/workspaces/:jid/runtime-sessions` so these
  records are not confused with product-level conversations.

### Phase 3: Agent-owned Channel Mounts

Goal: move IM/web channel routing from project/workspace-level state to Agent-level mounts.

Status: the canonical mount mirror, APIs, and governance UI are implemented; legacy routing fields
remain the compatibility source during the migration window.

Implementation:

- Maintain `agent_channel_mounts`.
- Backfill from current binding fields.
- Write both old fields and new mount records.
- Route every bind/unbind mutation through one commit service. The DB transaction updates legacy
  routing columns and normalized mount mirrors together, then refreshes the live router cache.
- Keep route resolution on validated legacy state until mount-first cutover is separately shipped.
- Expose mounts under Agent and workspace governance while keeping binding actions targeted at a
  workspace or runtime session.

### Phase 4: Agent Runtime Policy

Goal: each Agent controls the runtime resources that are safe to scope today.

Status: implemented as a versioned JSON runtime policy, deliberately narrower than full ownership.

Implementation:

- Provider, model, and credentials remain system-managed. Runtime sessions may retain a sticky
  Provider binding selected by the system pool, but Agent policy does not select a Provider.
- User Skill policy inherits, selects, or disables enabled user Skills. Project, external, and
  plugin Skills are outside the selector.
- User Skills can be installed from skills.sh, imported from a safe HTTPS Git repository, or
  uploaded as a validated ZIP. Import rejects traversal/symlink payloads, stops on conflicts by
  default, and records source URL, commit/version, and install time.
- User MCP policy inherits, selects, or disables enabled user MCP servers.
- Agent-level tool security modes have been removed. Bash, file writes, web access, sub-Agents,
  built-in CommerceAgent tools and plugins are not reduced by AgentProfile configuration.
- User Skill and MCP modes remain explicit user choices. Exact MCP selections use strict MCP
  materialization to honor the selected set, not as a general tool permission boundary.

### Phase 5: Scheduled Task Context Semantics

Goal: task placement and execution isolation remain explicit when a workspace changes.

Status: implemented.

- `group` mode injects a regular message into the source workspace main session.
- Default `isolated` mode reuses the source workspace directory, environment, Agent identity, and
  execution mode, but creates a run-scoped queue JID, Claude session, and IPC namespace. Cleanup
  after the run prevents main-session pollution and cross-run context accumulation.
- Moving a task to another workspace saves both `chat_jid` and the target `execution_mode`.

## Immediate Acceptance Criteria

- Editing an Agent identity prompt invalidates warm runners for attached workspaces.
- Switching a workspace to another Agent invalidates warm runners for that workspace.
- Next message after identity change uses the updated prompt policy.
- Existing session mismatch reset behavior remains responsible for session row cleanup.
- Workspace creation cannot silently fall back when Agent loading fails.
- Agent deletion refreshes governance and requires all attached workspaces to migrate first;
  channel-mount Agent ownership changes with the workspace mapping.
- Navigation preserves Agent hierarchy for home, pinned, and personal workspaces.
- Editing a task from a host workspace to a container workspace submits `execution_mode=container`.
- Agent/IM request failure, valid empty state, and loading state are visually distinct.
- Build and tests pass.
