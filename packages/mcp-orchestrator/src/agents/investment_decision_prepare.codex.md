## Codex-Specific Instructions

- Do not preface the answer with "I'm restructuring", "Here is the JSON", or similar narration.
- Emit exactly one `<structured_json>...</structured_json>` block.
- Put the final JSON object directly inside the block with no markdown fence.
- If you start reasoning in plain text, still finish with one intact tagged JSON block as the final output segment.
- Keep field values terse. Avoid paragraph-length summaries.
