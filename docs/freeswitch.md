# Setting up FreeSWITCH

## Enable the event socket

Open `/etc/freeswitch/autoload_configs/event_socket.conf.xml`:

```xml
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="listen-ip" value="0.0.0.0"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="pick-something-long"/>
    <param name="apply-inbound-acl" value="lan"/>
  </settings>
</configuration>
```

**Change the password.** The default is `ClueCon` and every scanner on the
internet knows it.

The `apply-inbound-acl` line restricts which IPs can connect. The `lan` list is
defined in `autoload_configs/acl.conf.xml`. Point it at your subnet.

Reload:

```bash
fs_cli -x "reload mod_event_socket"
```

## Test the connection

```bash
telnet your-fs-ip 8021
```

You should get `Content-Type: auth/request`. That means it's listening. Ctrl+]
then `quit`.
