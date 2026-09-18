# 7Seven-Corp Voice Sentinel v2

Each sentinel has its own target server and voice channel.

Only the logs server and logs channel are global/common.

## Config

```json
{
  "logsGuildId": "1272313642435477668",
  "logsChannelId": "1550545008988258325",
  "sentinels": [
    {
      "name": "Sentinel-01",
      "token": "ACCOUNT_TOKEN_1",
      "guildId": "TARGET_GUILD_ID_1",
      "channelId": "TARGET_VOICE_CHANNEL_ID_1",
      "enabled": true
    },
    {
      "name": "Sentinel-02",
      "token": "ACCOUNT_TOKEN_2",
      "guildId": "TARGET_GUILD_ID_2",
      "channelId": "TARGET_VOICE_CHANNEL_ID_2",
      "enabled": true
    },
    {
      "name": "Sentinel-03",
      "token": "ACCOUNT_TOKEN_3",
      "guildId": "TARGET_GUILD_ID_1",
      "channelId": "TARGET_VOICE_CHANNEL_ID_1",
      "enabled": true
    }
  ],
  "monitoring": {
    "initialRegion": "rotterdam",
    "pingLimit": 180,
    "criticalPingLimit": 350,
    "badSamplesRequired": 1,
    "checkInterval": 2000,
    "reconcileInterval": 5000,
    "switchCooldown": 12000,
    "criticalSwitchCooldown": 5000,
    "startupGrace": 6000,
    "postSwitchGrace": 5000,
    "connectingLimit": 5000,
    "signallingLimit": 5000,
    "disconnectedLimit": 3000,
    "noPingLimit": 20000,
    "stateFlapWindow": 12000,
    "stateFlapLimit": 3,
    "sentinelReconnectCooldown": 8000,
    "loginStagger": 1500,
    "switchQuorum": 0
  }
}
```

## Target grouping

Sentinels that use the same `guildId + channelId` are grouped together.

Example:

```text
Sentinel-01 -> Guild A / Voice X
Sentinel-02 -> Guild A / Voice X
Sentinel-03 -> Guild B / Voice Y
```

This creates two independent monitored targets:

```text
Target 1:
Sentinel-01 + Sentinel-02
Guild A / Voice X

Target 2:
Sentinel-03
Guild B / Voice Y
```

Each target has its own:

- RTC region state
- Rotterdam / US East failover
- cooldown
- degradation consensus
- quorum
- recovery

A problem on Guild A / Voice X will not switch the RTC region of Guild B / Voice Y.

## Logs

All alerts are sent to the single common:

```text
logsGuildId
logsChannelId
```

At least one configured account must be able to access this logs server/channel and manage/use webhooks there.

## Install

```bash
npm install discord.js-selfbot-v13 @discordjs/voice
```

Copy:

```text
config.example.json
```

to:

```text
config.json
```

Then run:

```bash
node index.js
```

## Quorum

If several sentinels monitor the same target, automatic majority is used by default:

```text
1 sentinel  -> 1 required
2 sentinels -> 2 required
3 sentinels -> 2 required
5 sentinels -> 3 required
```

Set `monitoring.switchQuorum` to a positive value to force a fixed quorum.

## Important

`config.json` contains account tokens and must never be committed.

Automated normal Discord user accounts/selfbots are not permitted by Discord's platform rules. Official bot accounts are the supported production approach.

## Showcase video



https://github.com/user-attachments/assets/8dcb5520-117e-403b-aa81-0edfc5907d1e


