STATUS: complete

# Silent writer on an exhausted provider ends as a provider limit

When an acp-opencode writer goes silent because its model hit a quota, Lane Pilot reads the OpenCode log on the writer host, ends the attempt within minutes as writer_provider_limit (class limit), opens the breaker until the reset time, and the task moves down the writer chain instead of being nudged for an hour.

Attempt 1 accepted by Lane Pilot BB writer.
