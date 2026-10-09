STATUS: complete

# Explicit service tier lookup is best-effort: providers.list failure never breaks a helper spawn

Make the explicit service tier lookup best-effort so helper spawns succeed when providers.list fails, restoring six failing tests.

Attempt 1 accepted by Lane Pilot BB writer.
