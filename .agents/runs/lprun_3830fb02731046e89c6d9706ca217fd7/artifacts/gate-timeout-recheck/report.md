STATUS: complete

# Integration gate: rerun load timeouts once before reporting a red batch

Stop the integration gate from reporting a false red batch and asking the owner when every failure is a test timeout caused by machine load: rerun the failing tests once and go green if they pass; also raise the default vitest testTimeout to 15 s.

Attempt 1 accepted by Lane Pilot BB writer.
