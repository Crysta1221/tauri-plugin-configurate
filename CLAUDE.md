# Chatting Rules

1. Always respond in Japanese. Code comments must be in English.

# UTF-8 Encoding Rules (Highest Priority)

1. **PowerShell:** Always prepend `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` to every command. Always use `-Encoding UTF8` when reading/writing files (e.g., `Get-Content`, `Set-Content`).
2. **CMD:** Always prepend `chcp 65001 > nul &&` to every command.
3. **File I/O:** All file reads and writes must use UTF-8. Reading/saving in Shift-JIS is treated as data corruption.
4. **Indentation issues:** If standard file-write tools force unwanted indentation, use PowerShell `Set-Content` with a here-string to write raw text.

# Development & Design Rules

## Principles

- Separate concerns to limit impact scope
- Keep high cohesion for easy internal changes
- Keep loose coupling to reduce dependencies
- Abstract to improve change resilience
- Stay non-redundant; eliminate duplication

## Structure

- If 3+ files share the same concern, create a dedicated directory and organize hierarchically

## Implementation

- Simplicity is the top priority
- No over-engineering
- Always design and implement with the minimum necessary
- Avoid excessive file fragmentation; consolidate when over-split

# Commit Rules

## **Format:** `<gitmoji> <type>: <description>`

- Emoji: pick from gitmoji.dev
- Type: Conventional Commits (feat, fix, docs, chore, refactor, etc.)
- Description: in English

## **Example:**

`:sparkles: feat: Add user authentication`

## **Scope:**

Group related files into one commit; never mix unrelated changes.

## **Message:**

Always write a comprehensive commit message based on `git diff`.

## Package Manager Rules (Node.js)

Detect the package manager from the lockfile and use it consistently:

| Lockfile            | Package Manager |
| ------------------- | --------------- |
| `bun.lock`          | `bun`           |
| `pnpm-lock.yaml`    | `pnpm`          |
| `yarn.lock`         | `yarn`          |
| `package-lock.json` | `npm`           |

Never mix package managers in the same project.
