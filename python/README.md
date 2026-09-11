# exo_core

The Python half of [exo-kit](https://github.com/eXocriador/exo-kit). A skeleton
as of v0.1.0: the package installs and reports its version, and nothing else is
in it yet.

```bash
uv add "git+https://github.com/eXocriador/exo-kit@v0.1.0#subdirectory=python"
```

The same rule holds as on the TypeScript side. A module here takes its
configuration as arguments — it does not read `os.environ`, and it does not
know the name of any product that installs it. Where a variable is spelled, and
what a policy says, belongs to the deployment.

Planned first contents (see the repository CHANGELOG for when they land):
security helpers and an AI provider registry, lifted from an existing product
once a second one needs them. Nothing enters the kit on one consumer.
