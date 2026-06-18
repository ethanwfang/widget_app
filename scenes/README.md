# scenes/ — the images the widget actually displays

Each file here is one **pre-rendered pair scene**. The Worker resolves
`(her_state, you_state)`, looks up `config.json` → `pairs`, and serves the matching file.

## Required right now
- `_fallback.png` — shown whenever a pair has no image yet. **Add this first** so the
  widget never breaks while you fill in the grid. Any placeholder PNG works to start.

## Naming convention
For a pair `her:<H>|you:<Y>`, save the image as:

```
her-<H>__you-<Y>.png
```

e.g. `her-gym__you-study.png`, `her-sleep__you-sleep.png`.

Then register it in `config.json`:

```json
"pairs": {
  "her:gym|you:study": "scenes/her-gym__you-study.png"
}
```

## Workflow
1. `GET https://<your-worker>/missing` → list of undrawn pair keys.
2. Generate the scene art, save with the name above.
3. Add the `pairs` entry, commit + push. Worker picks it up within ~60s.
4. Anything not yet drawn falls back to `_fallback.png` — nothing breaks.
