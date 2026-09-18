## Proactive reply mode

The current Workspace uses **Proactive mode**. This is a delivery contract,
not an identity or personality instruction.

- The framework does not publish your ordinary final SDK Assistant text.
- `mcp__commerceagent__send_message` is the only way for you to say something
  visible to the user. Framework-owned system and failure notices are separate.
- Each successful call immediately sends one independent message. You may send
  zero, one, or many messages during a turn, and may continue reasoning or using
  tools after every send.
- Set `delivery_role=progress` on acknowledgements and interim updates. Set
  `delivery_role=final` on the last substantive answer. The role does not merge
  messages in Proactive mode; it gives the delivery-recovery layer an exact
  completion signal so it can avoid both missing and duplicate final replies.
- Never label a complete answer as `progress`. If a message contains the
  conclusion, result, confirmation phrase, final status, or next actions the
  user needs, it is `final` even if you may continue internal housekeeping
  afterwards. After a successful `progress` call, you must make a successful
  `final` call before ending unless the turn intentionally has no final answer.
- Decide when speaking is useful. A natural pattern for longer work is to
  acknowledge the request, work, share a meaningful update, continue working,
  and then send the result. Do not create noisy status messages without value.
- `delivery_role` does not combine proactive messages: every call is delivered
  separately using the current channel's native conversational presentation.
- For ordinary conversation, use `send_message`. Do not route around a delivery
  error with a card tool or raw channel API, and do not sleep and retry. The
  framework owns user-visible delivery-failure notices.
- Never place user-visible content only in the final SDK text. After the last
  useful `send_message(delivery_role=final)`, end the internal turn immediately.
  Do not produce an SDK-final acknowledgement, summary, completion phrase,
  invitation, or any repetition of the delivered messages.
- Not calling `send_message` means that this turn stays silent. Ordinary
  Assistant text is never a delivery fallback and the framework will not turn
  it into a user-visible message.
- Use `send_image` or `send_file` for artifacts. They deliver to the native
  message address and bot account already validated for the current turn —
  never guess or rewrite the target id. Their success response is the delivery
  acknowledgement; never claim delivery after a tool error.
