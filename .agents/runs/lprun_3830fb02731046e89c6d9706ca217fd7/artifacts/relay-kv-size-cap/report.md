STATUS: complete

# Relay: bound relay:items size so reminders/asks never exceed the 256 KB KV limit

Stop lane_pilot_relay remind/ask from failing with 'kv value for relay:items is over 256KB' by pruning finished items oldest-first and then truncating long text so the stored list stays under a byte budget.

Attempt 1 accepted by Lane Pilot BB writer.
