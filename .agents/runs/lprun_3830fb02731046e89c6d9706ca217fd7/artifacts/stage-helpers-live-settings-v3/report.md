STATUS: complete

# Stage helpers (pm-read etc.) use current model settings at spawn time, not the run's frozen writer

Make pm-read and other stage helpers pick provider/model/effort/tier from the effective settings at spawn time, so changing a model in settings applies to running PM runs.

Attempt 1 accepted by Lane Pilot BB writer.
