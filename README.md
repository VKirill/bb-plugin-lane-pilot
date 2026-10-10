# Lane Pilot

![Lane Pilot: a captain crab plans, writer crabs dig their own branches, checks in a sandbox, merges into main](docs/images/hero.jpg)

Lane Pilot is a BB plugin that coordinates coding work from a project chat. It creates writer tasks, tracks checks and review, and provides project settings, memory, workflows, schedules, and maintenance tools.

## Quick start

Install Lane Pilot through BB's plugin manager, connect the project to an enrolled host, then use **Enable for this chat** in a new project composer. The plugin requires a BB server with the experimental `vk` APIs described in the [system overview](docs/overview.md).

For local development, install dependencies and run the package check:

```sh
npm install
npm run check
npm run test:changed  # only the tests that import files you changed; the full `npm test` is the deploy gate
```

## Documentation

- [System overview](docs/overview.md)
- [Architecture](docs/architecture.md)
- [Build and deployment](docs/deployment.md)
- [Cross-cutting gotchas](docs/gotchas.md)
- [Data model](docs/data-model.md)
- [Shared packages](docs/packages.md)
- [Architectural decisions](docs/decisions.md)
