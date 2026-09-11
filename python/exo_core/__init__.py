"""exo_core — the Python half of exo-kit.

A skeleton at v0.1.0. The TypeScript modules moved first because three products
already shared them byte for byte; nothing here has a second consumer yet, and
the rule that governs this repository is that a module enters it when two
products need it, not when one might.

The rule the modules will follow when they arrive:

    A module takes its configuration as arguments. It does not read
    ``os.environ`` and it does not know the name of any product that
    installs it.

Which is the same rule as on the TypeScript side, for the same reason: a
variable name is a fact about a deployment, and a library that hardcodes one
makes every deployment that spells it differently fail silently.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
