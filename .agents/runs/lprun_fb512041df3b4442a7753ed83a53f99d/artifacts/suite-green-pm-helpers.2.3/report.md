STATUS: complete

# Cover the stricter unscoped-SQL-deletion guard rule with tests

The guard rule refusing an SQL row deletion without WHERE is covered by tests for a statement followed by more SQL, a chained shell command, a scoped deletion and a grep pattern.

Attempt 2 accepted by Lane Pilot BB writer.
