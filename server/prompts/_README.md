# How prompt files work

Every `.md` file in this folder is combined (alphabetical order) into the LLM's system prompt.

- Edit any file and save — the next chat message uses the new rules. **No restart needed.**
- Add a new file, e.g. `05-seasonal-offers.md`, to add new behaviour.
- Files starting with `_` (like this one) are ignored.
- See the combined prompt at: http://localhost:3001/api/system-prompt
