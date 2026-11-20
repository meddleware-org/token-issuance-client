# Open standards and interoperability: token-issuance-client

Move rules, bytecode patching and the deploy flow for the token template.

This page lists what the project speaks today, what is planned, what was considered and does not apply, where someone else can extend it, and what proves each claim. The platform-wide list is [Standards we use](https://meddleware.dev/platform/standards). A row appears there in the same change that turns a standard on.

## Spoken today

- The pinned Move template, with a check that the artefact matches it
- The result is a standard Sui coin (the coin registry)

## Planned

- A machine-readable deployment result (JSON)

## Considered, not applicable

- none

## Extension points

- The template is its own package (@meddleware/token-issuance-template-sui)

## What proves it

- npm run check:template
- the localnet end-to-end run

_Maintained centrally with the platform's interoperability map; changes go through it so every repository says the same thing._
