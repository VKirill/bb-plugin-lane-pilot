---
title: Projects, sections and child Pilots
---

# Native project organization

Project Folders is the source of truth for the sidebar, section IDs, device paths and managed rules. Use its installed `project-folders` skill and CLI directly for organization; these calls do not need a writer or a workflow. Never edit its database or replace a project source merely to arrange the tree.

1. Discover with `bb project list --json`, `bb project-folders list --json`, and `bb host list --json`. Match the requested project/section and device before mutation. A code subdirectory is not automatically a registered section. Read failures are unknown state, not an empty tree.
2. Create a project with `bb project create --name NAME --root PATH --host HOST --json`. Create a section with `bb project-folders create PROJECT PARENT_OR_DASH NAME PATH HOST --json`. Existing directories are registered without overwriting their contents. Use the plugin skill for device-copy and path registration; never substitute another host after refusal.
3. For groups, renaming and ordering, use the plugin's documented RPC through `bb plugin rpc call project-folders METHOD --input-file FILE --json`. Relevant methods are `group_create`, `rename`, `reorder` and `section_reparent`; inspect their current schemas with `bb plugin rpc inspect project-folders METHOD --json` before calling (`rpc list project-folders --json` discovers methods). Read the tree back after a change. Rename changes the label, not the working directory.
4. Read/set managed rules with `bb project-folders rules show|set`; follow the plugin's rules reference. Do not edit managed AGENTS.md blocks behind the plugin. Keep user text outside the managed block.
5. File an existing chat with `bb project-folders place-chat THREAD PROJECT FOLDER_OR_DASH`; undo with `unplace-chat THREAD`. This changes its sidebar placement only. It does not move the working directory, change machine or create a parent relationship. A group holds sections, not chats.

## Work in another place

Use `lane_pilot_relay {action:"handoff"}` with the complete assignment, `targetProjectId` and (when handing off into a registered section's own folder) `targetSectionId`. No manual Pilot activation is needed. For multiple registered locations, supply a listed `targetHostId`/`targetPath` pair. Use `recipientThreadId` to continue the same child, or relay `ask`/`reply` for questions. Native BB child threads notify their parent automatically when their turn finishes, so `relay` does not wrap their prompts in `askId` boilerplate or send duplicate synthetic notifications. Preserve the authentic sender; agent assignments are actionable, but do not replace human confirmations.
When a registered section folder is its own standalone Git repository, writer worktrees clone/worktree only that section repository rather than the entire parent workspace.

The child owns its native run. The plugin creates a service-only bootstrap, awaits placement and then sends the assignment with the actual parent's identity. If the result names a created child or says delivery is unknown, inspect that child and handoff before retrying. Do not blindly create another child or resend the task.

> [!IMPORTANT]
> This organization access does not authorize arbitrary `threads.spawn`, the Project Folders `spawn` RPC, physical project/section/chat moves, destructive removal or wholesale backup import. For an explicit request to move this native PM chat, use `update_environment_directory` only when Core exposes it. It requires an idle same-project, same-host chat: no in-flight admissions, active/queued writers, parked tasks, or resumable phases/workflows. Close phases and finish or cancel workflow runs first. The old run and history remain in the old checkout; the move creates one fresh bound run. End the current turn after success. On older Core the tool stays unavailable; use a child Pilot instead. Existing owner-confirmation and permission rules still apply; do not turn a refusal into a shell or RPC bypass. Read the plugin skill before archive/deletion/move requests and report a missing supported path honestly.

Project Folders remains responsible for destination validation, managed-file concurrency, registered source checks and data persistence. A successful organization command is not evidence that delegated business work completed. After release, a resident PM session may need a fresh session attachment to load its updated prompt and guard.
