STATUS: complete

# Update stale owner-ask H8 test: the integration gate no longer asks the owner

Make tests/owner-ask.test.ts match the intended behaviour from commit 5a000d0: a red integration gate tells the PM by message (ANSI stripped) and never opens an owner form.

Attempt 1 accepted by Lane Pilot BB writer.
