# AI and camera reliability

Implement the approved audit corrections with the existing Django/browser architecture.

- Reject malformed envelopes and trailing AI prose instead of discarding qualifications. Keep whole-batch recognition validation: skipping invalid entries could hide missing inventory.
- Reserve time for configured fallbacks. Share provider selection with the diagnostic command.
- Clear closed-draft transcript/context, including new sanitized backups and previously closed database rows. Leave existing backup files untouched.
- Refuse destructive over-limit merges. Refresh cached search item data and invalidate changed-item explanations.
- Keep a persistent camera file input, server decoding fallback, bounded upload wait and visible retry using the same selected photo. Refresh the owner session after camera return; reuse a draft UUID to make uncertain upload retries safe.
- Verify server boundaries with Django tests and browser journeys with failure injection; validate the deployed revision, public assets and synthetic AI request. Native iPhone/Comet camera behavior still requires a device check.

Rejected alternatives: silently shorten model output, silently omit invalid recognition rows, or add a background upload/AI queue. The existing draft review and server image normalization cover this scope.
