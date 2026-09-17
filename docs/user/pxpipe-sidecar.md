# pxpipe sidecar

pxpipe is a local proxy for the Anthropic Messages API. It redraws the bulky
parts of a request as dense images before forwarding it, which cuts the input
tokens a Claude turn spends. T3 Code can run one pxpipe per environment and
send the Claude instances you pick through it.

## Turn the sidecar on

Open **Settings > Sidecars > pxpipe** in the web or desktop app, select the
environment, and turn on **Run the pxpipe sidecar**. The environment installs a
pinned pxpipe the first time it starts one, so that first start needs network
access. Later starts work offline.

pxpipe listens on loopback port `47821` unless you change **Port**. Leave
**Imaging models** empty to keep pxpipe's own default, or set a single entry of
`off` to run the proxy without imaging. **Log path** decides where pxpipe writes
its log on the environment's machine, which is the place to look when a turn
through the proxy misbehaves.

The same page shows what the proxy reports about itself: requests handled, how
many it compressed, the share of input it saved, and its own estimate of the
money saved. Those figures come from the proxy, not from T3 Code, and refresh
when you ask for them.

## Route a Claude instance

Routing is opt-in per instance. Open **Settings > Providers**, choose a Claude
instance, and turn on **Route through pxpipe**. Instances you leave alone keep
talking to Anthropic directly and behave the same as before. Only Claude
instances offer the switch, because pxpipe serves the Anthropic API.

Running the sidecar on its own sends no traffic through it. Nothing changes
until you route at least one instance.

## What a routed instance gives up

Routing points the instance at the proxy instead of Anthropic, and Claude Code
treats a custom endpoint as a signal to switch off its first-party client
features. On a routed instance, `/remote-control` and claude.ai connectors stop
working. Unrouted instances keep both.

pxpipe rewrites request bodies, so a routed instance can lose Claude
prompt-cache hits and pay full price for a turn it would otherwise have read
from cache.

Use a second Claude instance if you want both: route one, leave the other
direct, and switch a thread between them.

## When the sidecar is not running

A routed instance never falls back to Anthropic directly. If the sidecar is not
healthy when you send a message, the turn fails and the thread records which
status the sidecar was in and the last error it reported. Start the sidecar
again from **Settings > Sidecars > pxpipe** and send the message again.

A status of **Unhealthy** means the environment is already restarting the
process. **Failed** means it gave up, so only an explicit start brings it back.

## A pxpipe you started yourself

If something already answers on the configured port, T3 Code uses it as it
finds it. Routed instances go through it and the status reads **Running (started
outside T3 Code)**, but T3 Code will not restart it, stop it, or replace it with
its own copy. Stop it the way you started it.

## An instance that sets its own endpoint

A hand-set endpoint always wins. If an instance sets `ANTHROPIC_BASE_URL` in its
own **Environment variables**, or the server process inherited that variable,
the instance keeps that value and its turns never reach the sidecar. The
instance's settings say **Routing inactive** in that case. Remove the variable
to route through the sidecar instead. This is what happens to instances set up
for [OpenRouter or another router](./providers-claude.md#openrouter): they point
somewhere else on purpose, so leave routing off for them.

## Reclaim the disk

T3 Code keeps the pxpipe it installed in the environment's T3 home. Use
**Remove** under **Cached install** to delete the installs it holds there. Stop
the sidecar first, because T3 Code refuses to delete an install underneath a
running process. The next start installs the pinned version again.
