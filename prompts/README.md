# Prompts

Reference copies of the primary agent prompts. The live definitions live in
`.opencode/agent/*.md` — edit those files to change behavior, or edit here and
copy over. Agents are loaded once at opencode startup, so restart opencode
after any change.

- `architect-a.md` — first planner: draft build spec.
- `architect-b.md` — second planner: critique + finalize.
- `builder.md` — executor: implement milestones, delegate, commit+push.

## Switching AI models

Agents that pin a `model:` in their frontmatter always use that model:

- `architect-a` → `openai/gpt-5.6-luna` (ideation / draft spec)
- `architect-b` → `openai/gpt-5.6-terra` (critique / finalize)
- `builder` → `openai/gpt-5.6-terra` (implementation)

Everything else — all 22 subagents — follows the default model set in
`opencode.json` under `model` (currently `openai/gpt-5.6-sol`). Switch the
subagent model anytime in the TUI with `/model`, or pass `--model` on the CLI:

```
opencode run --agent frontend-web "buhati ang landing page" --model openai/gpt-5.6-sol
```

Subagents spawned mid-session use the model selected at that moment, so
`/model` affects subsequent delegated work too.

## Quick reference

```
opencode run --agent architect-a "idea ko: ..."
opencode run --agent architect-b "review sa build-spec.md"
opencode run --agent builder "sugdi ang milestone 1"
```
