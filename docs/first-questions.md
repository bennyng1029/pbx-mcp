# Your first questions

Start here, because if this fails nothing else will work:

> Is my PBX up?

That runs `asterisk_status` or `freeswitch_status` and comes back with version
and uptime.

Then try the everyday ones:

> What calls are live right now?

> Is extension 1001 registered?

> Which of my SIP trunks are down?

> Show me the dialplan for from-internal

> Any channels that have been up longer than an hour?

The assistant picks tools from their descriptions, so plain language works
better than command names. Ask "which phones are offline" rather than "run
pjsip show endpoints."

## Where it gets useful

Chained questions are the real win:

> Outbound calls to the UK are failing. Can you work out why?

A decent assistant will check the switch is alive, look at gateway
registration, list recent channels to see how far calls get, and pull the
dialplan for the route. Four commands across two syntaxes, one sentence from
you.
