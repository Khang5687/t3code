# Forking a thread

Fork a thread from one of your messages to try a different direction while keeping
the original. The fork is a new thread in the same project, named after its source
with "(fork)" added. It holds the conversation up to the message you chose, and that
message's text and attachments wait in its composer so you can edit and send them.
It starts with the source's model, permission mode, and Plan mode setting. The
source thread does not change.

[Edit from here](./composer.md#edit-an-earlier-prompt) does the same thing in place
and rewinds the thread itself.

## Fork from a message

On web and desktop, choose **Fork from here** beneath a sent message. On mobile,
touch and hold your message and choose **Fork from here**.

Then pick where the fork works:

- **Fork in same workspace** uses the source's branch and working directory.
- **Fork into new worktree** checks out a new worktree and restores its files to how
  they were when you sent the chosen message.

The worktree option appears only for Git projects, and only when T3 Code captured a
checkpoint at that point in the thread. When it is missing, mobile forks into the
same workspace straight away.

A new-worktree fork shows its checkout, file restore, and the project's setup script
as a setup card, like any new worktree thread. You can send once the setup script
starts; a failed script shows its exit code on the card and leaves the fork usable.
If the checkout or restore fails or you cancel it, the fork stays in the sidebar
with the failed card and takes no messages. Delete it and fork again.

## Choose where you land

By default T3 Code opens the fork. To stay on the source instead, change
**Settings → General → After forking** on web and desktop, or **Settings → Thread
behavior → After forking** on mobile, to **Stay on the source**. A notification then
lets you open the fork. Each device keeps its own choice.

## Provider support

Forking is offered for Codex, Claude, and OpenCode threads, the same providers that
support Edit from here. Cursor, Grok, and Antigravity cannot rewind a conversation,
so their threads have no fork action.

Creating a fork does not contact the provider. On your first message, the fork
continues from a copy of the source's provider session, so the agent keeps its full
memory of the earlier conversation and the source's session is left as it was.

When that copy cannot be made, the fork shows a warning that it could not resume the
original session, and the agent does not receive that first message. This happens
when the source was deleted, its provider session is gone, or you switched the fork
to another provider or account before sending. Send the message again to start a
fresh session that gets the copied conversation as text. Long conversations are
shortened and attachments are listed by name only, so the agent may need a reminder
of earlier details.

## Things to know

- You can fork while the source's agent is still working. The fork copies the
  messages that exist at that moment, and the source keeps running.
- A same-workspace fork shares files with its source. Both agents edit the same
  checkout, so use a new worktree when the two should not collide.
- The fork shows **Forked from** with the source's title, which opens the source.
  If you delete the source, the fork keeps working and the line shows the title the
  source had when you forked it.
- Deleting a fork is like deleting any other thread. A new-worktree fork asks about
  removing its worktree the way other worktree threads do. A same-workspace fork of
  a worktree thread shares that worktree, so T3 Code does not offer to remove it
  while the other thread still uses it.
