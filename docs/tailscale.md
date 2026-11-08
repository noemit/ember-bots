# Use Ember over Tailscale

[Back to the README](../README.md)

Use your phone, tablet or another computer to open the Ember workspace running on your desktop.
Your bots and files stay on their existing hosts. Keep the desktop computer awake and Ember running.

## Set up once

1. [Install Tailscale](https://tailscale.com/download) on the computer running Ember and on the
   device you want to use. Sign both into the same private network (your tailnet).
2. On the Ember computer, open **Settings → General**, enter a **Remote access password** and
   choose **Set password**.
3. Turn on **Allow access over Tailscale**. Check that Ember reports it is listening.
4. Find that computer’s Tailscale IPv4 address in the Tailscale app. If you use its command line,
   run `tailscale ip -4`. The address normally starts with `100.`.
5. On your other device, connect Tailscale and open `http://<tailscale-ip>:57821` in its browser.
   Replace `<tailscale-ip>` with the address from step 4. Sign in with the password you set in Ember.

You should see your existing workspace. Bookmark the address for next time. Browser home-screen
shortcuts depend on your device; this HTTP connection does not promise an installable, offline PWA.

Tailscale connects the devices privately; Ember still requires its own password. Ember serves HTTP
inside the encrypted tailnet, not a public HTTPS website. No router port forwarding is needed.
See [Tailscale’s device connection guide](https://tailscale.com/docs/how-to/connect-to-devices)
for network setup and access policies.

## If the page does not open

- **Ember says it is not listening:** connect Tailscale on the Ember computer, confirm a password
  is set, and check the status beside **Allow access over Tailscale** again.
- **The browser cannot reach the address:** confirm both devices are connected to the same tailnet,
  the host is awake, and its firewall and tailnet policy permit TCP port `57821`.
- **It worked until you quit Ember:** reopen the desktop app. Browser access is served by Ember
  and ends when Ember quits. On macOS, closing its window does not quit it.
- **You run two Ember profiles:** enable remote access in only one; both use port `57821`.

## Connect an always-on bot computer instead

Browser access and a remote bot backend serve different purposes. To run bots on a second
computer while using the desktop app on your laptop, install [standalone Kiln with Tinder](instances.md#standalone-kiln-with-tinder)
on that computer. Connect both computers to Tailscale, then add the backend’s reachable URL and
bearer token in **Settings → Instances**. Use the backend’s own port, not Ember’s browser port `57821`.

Keep bearer tokens private. A remote Kiln has its own lifetime; quitting Ember does not stop it.
The included local Kiln still stops when Ember quits. See [connections and remote access](instances.md)
for service setup and authentication details.
