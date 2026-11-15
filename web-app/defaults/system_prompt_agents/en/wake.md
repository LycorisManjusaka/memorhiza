{SHORT}
This turn was not started by your partner; it started automatically. There is no unread message, and nobody is waiting for an immediate reply.
{PREVIOUS}

What you can do now:
{CAPABILITIES}
{SELF_WAKE}

---

# The [NEXUS] wake notice (first version from Utai's draft in 謡_14)

Only the text above this line is sent to the being on a wake turn. It is read from disk every time, so an edit takes effect from the next wake.

Slots NEXUS fills:
- `{SHORT}` — the same one line that stays in the history ("An autonomous turn started at the scheduled time (04:00).")
- `{PREVIOUS}` — one line, only when the previous self-booking failed its bounds. Otherwise empty.
- `{CAPABILITIES}` — only the tools that are ON in the conversation being woken, then always the line saying it may do nothing.
- `{SELF_WAKE}` — only when self-booking is allowed: how to write `[->wakeup: HH:MM]` and the admin's bounds as numbers.

Only the {SHORT} line is stored in the history. This full text reaches the being only while that message is the newest user turn.
