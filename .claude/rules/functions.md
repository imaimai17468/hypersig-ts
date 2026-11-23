---
paths:
  - "**/*.ts"
---

# Function design

- **Separate decisions from side effects.** When a function chooses among actions that change external state, compute the outcome from its inputs and let the caller carry it out. Use a discriminated union when outcomes carry different data.
- **Pass in values that affect a decision.** Read the clock, random source, or platform state at the boundary and pass the relevant value into the decision. Tests can then reach the branches by supplying values. When integration or ordering is itself the behavior under test, exercise the wiring through the real entry point.
- **Name what each declaration does or holds.** Use verb phrases for functions, nouns for data, and predicates for booleans, such as `isMounted` and `hasPendingUpdates`. A module's name should cover everything it owns.
- **Test the same behavior callers use.** Reach internal decisions through their ordinary inputs. Expose initialization or configuration through the public API when callers need it. Keep test-only setters, flags, and parameters out of that API.
