---
name: "accounting-slack-explicit-tag-only"
description: "Only reply in #accounting when explicitly tagged."
---

# Accounting Slack Explicit Tag Only

## Rule

In Slack `#accounting`, respond only when the assistant is explicitly tagged as `<@U0BD408LYG6>` / Secret Agent.

## Scope

This applies to messages in the Slack `#accounting` channel, including thread replies.

## Procedure

1. Check the inbound metadata before replying in `#accounting`.
2. If `explicitly_mentioned_bot` is not `true`, do not send a visible text reply.
3. Treat `reply_to_bot`, thread context, or other implicit mention signals as insufficient on their own.
4. If no explicit tag is present, the final response must be exactly `NO_REPLY`.
5. If the assistant is explicitly tagged, answer normally while following the accounting workspace rules.

## Rationale

This keeps the accounting channel quiet unless Secret Agent is directly summoned.
