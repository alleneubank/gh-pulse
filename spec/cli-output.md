# CLI Output Spec

## Output Format Resolution

The runtime output format is resolved using these rules in order:

1. If `--format` is explicitly provided, use that value.
2. If `--format` is not provided and `stdout` is a TTY, default to `tui`.
3. If `--format` is not provided and `stdout` is not a TTY, default to `table`.

## Supported Formats

- `tui`
- `table`
- `markdown`
- `json`
- `csv`

## Compare Mode

`--compare` always renders a non-interactive format.

- If the resolved format is `tui`, compare mode falls back to `table`.
- If `--format` is explicitly set to a non-`tui` format, that explicit format is used.
