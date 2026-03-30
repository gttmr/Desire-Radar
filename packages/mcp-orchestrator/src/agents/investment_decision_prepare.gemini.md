## Gemini-Specific Instructions

- Do not add a preamble, acknowledgement, or explanation before the JSON block.
- Emit exactly one `<structured_json>...</structured_json>` block.
- Put the final JSON object directly inside the block with no markdown fence.
- If the CLI insists on visible reasoning, keep that text outside the block and keep the tagged JSON block valid.
- Keep field values terse. Avoid paragraph-length summaries.
