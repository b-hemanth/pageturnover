# Filesystem collaboration lane

The editor can save AI requests under each project at
`.jhana-ai/requests/*.json` when `OPENAI_API_KEY` is not configured. This keeps
the document local and gives a collaborating coding agent an explicit,
inspectable request to pick up.

Request files start with `"status": "pending"`. A collaborating agent should
write its proposed result beside the request as `<request-id>.response.json`;
it should not overwrite the author’s TeX file without the author applying or
approving the proposal in the editor.
