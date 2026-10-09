# Bump the pinned Lane Stack for native install (stale OpenCode guard keeps coming back)

## Problem (verified 2026-10-09 by errand thr_pfxyqnz7ym)
`NATIVE_STACK_SHA` in src/rooms/native-install/native-install-bootstrap.ts pins Lane Stack at `c3a88d0dc829f20934f37ebe40ad01ba7bfe67c3`. Lane Pilot's install/enable step checks out that commit into `~/.local/share/claude-lane-stack-installed` on the Mac mini and the MacBook. It then copies the OpenCode plugin files from there (native-install-host.ts → native-lane-reconcile.ts). That commit's `profiles/opencode/opencode-lane/guard.ts` allows only `ui-ux-pro-max`, so OpenCode writers get «[opencode-lane guard] skill blocked: writer-practices / karpathy-guidelines». Lane Stack fixed the guard in 1.64.7, commit 1d130c4.

On 2026-10-09 the errand installed current files by hand. Lane Pilot rewrote the old guard on the Mac mini at 13:38 today, and it will again on the next install/enable.

## Fix
- Set `NATIVE_STACK_SHA` to `45fa19eab528d92d8ce2744d49153ecb4133ea33`. This is the current Lane Stack origin/main; it contains the guard fix and later install fixes.
- Update any test that pins the old SHA. A grep finds the string only in native-install-bootstrap.ts, but check tests that assert install steps.
- If the reconcile only re-copies when the pinned SHA changes, confirm that the bump makes hosts with the old checkout fetch and copy the new files on the next reconcile.
- Add a regression test: the installed checkout's guard source for the pinned SHA must allow writer-practices and karpathy-guidelines. A cheap way is a constant test asserting the SHA is not c3a88d0. Better: if a test fixture can read the pinned file from git (`git show <sha>:profiles/opencode/opencode-lane/guard.ts` is not available offline), keep it to a unit check on the reconcile logic.

## Delivery
- [x] Pinned native installation to Lane Stack 45fa19e so OpenCode receives the updated guard — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `3bc1d38`.
