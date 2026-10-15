Failures (from the deploy test run): boundaries test reports new deep imports council>relay 1, self-repair>relay 2, settings>relay 1, workflow>relay 1 (owner-locale.ts imported directly). self-repair H8 expects title toContain "Self-repair" but the form is now Russian by default.
Steps:
- [x] Export the owner-locale functions from src/rooms/relay/server/index.ts and switch the four rooms' imports to that index.
- [x] Update the H8 assertion to the Russian title and cover the English locale where supported.
- [x] Run verification.
