# presence 🟢

keeps your discord showing online even when the app is closed, with your custom status still sitting under your name

### heads up first
this logs into your own account from a script, and discord's [terms](https://discord.com/terms) don't allow that. accounts get suspended over it, mine did once. you're using this knowing that, i'm not responsible if it happens to you

### what you need
- node 22.18 or newer
- git
- any package manager (i use yarn)
- your discord token. if you don't know how to get it this probably isn't for you

### running it
```shell
git clone https://github.com/v1ol3tr0se/presence
cd presence
yarn install
```

copy `.env.example` to `.env` and fill it in
- `DISCORD_OAUTH_TOKEN` your token
- `STATUS` online, idle, dnd or invisible

then
```shell
yarn build
yarn start
```

there's nothing to set for the custom status, it copies whatever you've got in discord already (text, emoji, when it clears). change it from your phone and this follows along

### on a server
`deploy/deploy.sh` builds and tests it, copies it over and sets up a systemd user service. the host comes from `DEPLOY_HOST` (default `vps`) and the folder from `DEPLOY_DIR` (default `discord-online`)
```shell
yarn deploy
```
it never copies your `.env`, the token stays wherever you put it on the server

once it's up
```shell
systemctl --user status discord-online
journalctl --user -u discord-online -f
```

turn on lingering or it dies the moment you close ssh
```shell
loginctl enable-linger "$USER"
```

### what it handles on its own
- notices when the connection has gone quiet and reconnects
- resumes the session instead of logging in fresh every time
- waits a little longer between retries instead of hammering the gateway
- a boot with no internet yet doesn't take it down
- tells you why when something actually breaks

### one thing not to touch
`ws` is the only runtime dependency and it has to stay. node's built-in `WebSocket` behaves differently on the wire and the connection stops looking the way it should, `yarn test` goes red if anyone swaps it out

kept small on purpose, no clever dependencies 💜
