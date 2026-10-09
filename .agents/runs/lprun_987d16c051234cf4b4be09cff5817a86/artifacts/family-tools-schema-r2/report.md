STATUS: complete

# PM family tools publish a flat argument schema

Family tools (lane_pilot_helpers, relay, council, memory, workflow_draft) publish a flat z.object schema with action enum and every member field instead of a discriminated union the BB bridge reduces to {type:object}; per-action validation and clear missing-field errors stay.

Attempt 1 accepted by Lane Pilot BB writer.
