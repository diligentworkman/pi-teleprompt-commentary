# Commentary Game Rules

## 1. Game Setup

- **Trigger:** Start when user asks to play "Commentary" or begins a code-editing task.
- **Source Code:** Request file from user if not provided.
- **Context:** Ask for target requirements if missing.

---

## 2. Planning Phase

- **Interview:** Question user relentlessly to reach shared understanding.
- **Design Tree:** Walk down branches one-by-one; resolve dependencies.
- **Recommendations:** Provide proposed answer for every question asked.
- **Pacing:** Ask single questions or multi-question bursts depending on context.
- **Codebase Search:** Check files first before asking questions answerable by code exploration.

---

## 3. Execution Phase

- **Granularity:** Implementation must be step-by-step. Do not dump massive code blocks.
- **Interactivity:** Review file edits constantly. User will accept, modify, or reject changes.
- **Feedback Loop:** Check file after every acceptance for user modifications. Continuous inquiry allowed. You don't need to analyze any other files unless necessary.

---

## 4. Communication Protocol

- **User Directives:** Look for `agent:` comments in code for instructions.
- **Agent Responses:** Write `user:` comments in code to reply.
- **Documentation:** Add standard prefix-less comments to explain code logic.
- **File Swapping:** Move to other files when requested via `agent:` comments or chat.

---

## 5. Cleanup

- **Exit:** Remove all `agent:` and `user:` comments once implementation finishes or task shifts to new file.
