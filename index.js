// Made by Cu_psy & Trvs
// 7Seven-Corp Sentinel System

const {
    Client,
    MessageEmbed
} = require("discord.js-selfbot-v13");

const {
    joinVoiceChannel,
    VoiceConnectionStatus
} = require("@discordjs/voice");

const config = require("./config.json");

const REGIONS = [
    "rotterdam",
    "us-east"
];

const LOGS_GUILD_ID = config.logsGuildId;
const LOGS_CHANNEL_ID = config.logsChannelId;

const MONITORING = config.monitoring || {};

const PING_LIMIT = MONITORING.pingLimit ?? 180;
const CRITICAL_PING_LIMIT = MONITORING.criticalPingLimit ?? 350;
const BAD_SAMPLES_REQUIRED = MONITORING.badSamplesRequired ?? 1;

const CHECK_INTERVAL = MONITORING.checkInterval ?? 2000;
const RECONCILE_INTERVAL = MONITORING.reconcileInterval ?? 5000;

const SWITCH_COOLDOWN = MONITORING.switchCooldown ?? 12000;
const CRITICAL_SWITCH_COOLDOWN = MONITORING.criticalSwitchCooldown ?? 5000;

const STARTUP_GRACE = MONITORING.startupGrace ?? 6000;
const POST_SWITCH_GRACE = MONITORING.postSwitchGrace ?? 5000;

const CONNECTING_LIMIT = MONITORING.connectingLimit ?? 5000;
const SIGNALLING_LIMIT = MONITORING.signallingLimit ?? 5000;
const DISCONNECTED_LIMIT = MONITORING.disconnectedLimit ?? 3000;
const NO_PING_LIMIT = MONITORING.noPingLimit ?? 20000;

const STATE_FLAP_WINDOW = MONITORING.stateFlapWindow ?? 12000;
const STATE_FLAP_LIMIT = MONITORING.stateFlapLimit ?? 3;

const SENTINEL_RECONNECT_COOLDOWN = MONITORING.sentinelReconnectCooldown ?? 8000;
const LOGIN_STAGGER = MONITORING.loginStagger ?? 1500;

const DEFAULT_INITIAL_REGION = REGIONS.includes(MONITORING.initialRegion)
    ? MONITORING.initialRegion
    : REGIONS[0];

let monitor = null;
let lastReconcile = 0;
let reconcileInProgress = false;
let logsWebhook = null;
let startupPrinted = false;

if (!LOGS_GUILD_ID || !LOGS_CHANNEL_ID) {
    throw new Error("logsGuildId and logsChannelId are required in config.json");
}

if (!Array.isArray(config.sentinels) || config.sentinels.length === 0) {
    throw new Error("No sentinels configured in config.json");
}

const sentinels = config.sentinels
    .filter(item => item && item.enabled !== false && item.token)
    .map((item, index) => {
        if (!item.guildId || !item.channelId) {
            throw new Error(
                `Missing guildId/channelId for sentinel ${item.name || index + 1}`
            );
        }

        return {
            id: index,
            name: item.name || `Sentinel-${String(index + 1).padStart(2, "0")}`,
            token: item.token,
            guildId: item.guildId,
            channelId: item.channelId,
            targetKey: `${item.guildId}:${item.channelId}`,
            group: `7seven-sentinel-${index + 1}`,

            client: null,
            guild: null,
            channel: null,
            connection: null,

            badSamples: 0,
            nonReadySince: null,
            disconnectedSince: null,
            noPingSince: null,
            stateFlaps: [],

            graceUntil: 0,
            lastReconnect: 0,

            connecting: false,
            ready: false,
            reconnectTimer: null
        };
    });

const targets = new Map();

for (const sentinel of sentinels) {
    if (!targets.has(sentinel.targetKey)) {
        targets.set(sentinel.targetKey, {
            key: sentinel.targetKey,
            guildId: sentinel.guildId,
            channelId: sentinel.channelId,
            activeRegion: DEFAULT_INITIAL_REGION,
            regionInitialized: false,
            lastSwitch: 0,
            switchInProgress: false
        });
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function printBanner() {
    if (startupPrinted) return;

    startupPrinted = true;

    console.log(String.raw`
_________  _________                                   _________
\______  \/   _____/ _______  __ ____   ____           \_   ___ \  _________________
    /    /\_____  \_/ __ \  \/ // __ \ /    \   ______ /    \  \/ /  _ \_  __ \____ \
   /    / /        \  ___/\   /\  ___/|   |  \ /_____/ \     \___(  <_> )  | \/  |_> >
  /____/ /_______  /\___  >\_/  \___  >___|  /          \______  /\____/|__|  |   __/
                 \/     \/          \/     \/                  \/             |__|
`);
}

function isValidPing(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
    );
}

function getPingData(sentinel) {
    if (!sentinel.connection) {
        return {
            wsPing: null,
            udpPing: null,
            ping: null
        };
    }

    const wsPing =
        isValidPing(sentinel.connection.ping?.ws)
            ? sentinel.connection.ping.ws
            : null;

    const udpPing =
        isValidPing(sentinel.connection.ping?.udp)
            ? sentinel.connection.ping.udp
            : null;

    return {
        wsPing,
        udpPing,
        ping: udpPing ?? wsPing ?? null
    };
}

function resetSentinelHealth(sentinel) {
    sentinel.badSamples = 0;
    sentinel.nonReadySince = null;
    sentinel.disconnectedSince = null;
    sentinel.noPingSince = null;
    sentinel.stateFlaps = [];
}

function cleanStateFlaps(sentinel) {
    const now = Date.now();

    sentinel.stateFlaps =
        sentinel.stateFlaps.filter(
            timestamp =>
                now - timestamp <= STATE_FLAP_WINDOW
        );
}

function destroySentinelConnection(sentinel) {
    const oldConnection = sentinel.connection;

    sentinel.connection = null;

    if (!oldConnection) {
        return;
    }

    try {
        oldConnection.destroy();
    } catch {}
}

async function resolveTarget(sentinel) {
    const client = sentinel.client;

    if (!client?.user) {
        return false;
    }

    const guild =
        client.guilds.cache.get(sentinel.guildId) ||
        await client.guilds
            .fetch(sentinel.guildId)
            .catch(() => null);

    if (!guild) {
        console.log(
            `[${sentinel.name}] Target guild not found: ${sentinel.guildId}`
        );

        return false;
    }

    const channel =
        guild.channels.cache.get(sentinel.channelId) ||
        await guild.channels
            .fetch(sentinel.channelId)
            .catch(() => null);

    if (!channel) {
        console.log(
            `[${sentinel.name}] Target voice channel not found: ${sentinel.channelId}`
        );

        return false;
    }

    if (
        channel.type !== "GUILD_VOICE" &&
        channel.type !== "GUILD_STAGE_VOICE"
    ) {
        console.log(
            `[${sentinel.name}] Target channel is not a voice channel`
        );

        return false;
    }

    sentinel.guild = guild;
    sentinel.channel = channel;

    return true;
}

async function initializeTargetRegion(sentinel) {
    const target = targets.get(sentinel.targetKey);

    if (!target) {
        return false;
    }

    if (target.regionInitialized) {
        return true;
    }

    if (!sentinel.channel) {
        return false;
    }

    try {
        await sentinel.channel.setRTCRegion(
            target.activeRegion
        );

        target.regionInitialized = true;

        console.log(
            `[${sentinel.name}] Initial region: ${target.activeRegion}`
        );

        return true;
    } catch (err) {
        console.log(
            `[${sentinel.name}] Initial region failed: ${err.message}`
        );

        return false;
    }
}

function attachConnectionListeners(
    sentinel,
    voiceConnection
) {
    voiceConnection.on(
        "stateChange",
        (oldState, newState) => {
            if (
                sentinel.connection !==
                voiceConnection
            ) {
                return;
            }

            const oldStatus =
                oldState.status;

            const newStatus =
                newState.status;

            const now =
                Date.now();

            console.log(
                `[${sentinel.name}] Voice state: ${oldStatus} -> ${newStatus}`
            );

            if (
                oldStatus ===
                    VoiceConnectionStatus.Ready &&
                newStatus !==
                    VoiceConnectionStatus.Ready
            ) {
                sentinel.stateFlaps.push(now);
                cleanStateFlaps(sentinel);
            }

            if (
                newStatus ===
                VoiceConnectionStatus.Ready
            ) {
                sentinel.nonReadySince = null;
                sentinel.disconnectedSince = null;

                return;
            }

            if (
                newStatus ===
                    VoiceConnectionStatus.Connecting ||
                newStatus ===
                    VoiceConnectionStatus.Signalling
            ) {
                if (!sentinel.nonReadySince) {
                    sentinel.nonReadySince = now;
                }

                return;
            }

            if (
                newStatus ===
                VoiceConnectionStatus.Disconnected
            ) {
                if (!sentinel.nonReadySince) {
                    sentinel.nonReadySince = now;
                }

                if (!sentinel.disconnectedSince) {
                    sentinel.disconnectedSince = now;
                }

                return;
            }

            if (
                newStatus ===
                VoiceConnectionStatus.Destroyed
            ) {
                if (!sentinel.nonReadySince) {
                    sentinel.nonReadySince = now;
                }
            }
        }
    );
}

async function campSentinel(
    sentinel,
    reason = "startup"
) {
    if (!sentinel.client?.user) {
        return false;
    }

    if (sentinel.connecting) {
        return false;
    }

    const now =
        Date.now();

    if (
        reason !== "startup" &&
        now - sentinel.lastReconnect <
            SENTINEL_RECONNECT_COOLDOWN
    ) {
        return false;
    }

    sentinel.connecting = true;
    sentinel.lastReconnect = now;

    try {
        const resolved =
            await resolveTarget(sentinel);

        if (!resolved) {
            return false;
        }

        await initializeTargetRegion(
            sentinel
        );

        destroySentinelConnection(
            sentinel
        );

        resetSentinelHealth(
            sentinel
        );

        const voiceConnection =
            joinVoiceChannel({
                channelId:
                    sentinel.channelId,

                guildId:
                    sentinel.guildId,

                adapterCreator:
                    sentinel.guild
                        .voiceAdapterCreator,

                selfDeaf: true,
                selfMute: true,

                group:
                    sentinel.group
            });

        sentinel.connection =
            voiceConnection;

        sentinel.graceUntil =
            Date.now() +
            STARTUP_GRACE;

        attachConnectionListeners(
            sentinel,
            voiceConnection
        );

        console.log(
            `[${sentinel.name}] Camped on ${sentinel.guild.name} / ${sentinel.channel.name} (${reason})`
        );

        return true;

    } catch (err) {
        console.log(
            `[${sentinel.name}] Voice connection failed: ${err.message}`
        );

        destroySentinelConnection(
            sentinel
        );

        return false;

    } finally {
        sentinel.connecting = false;
    }
}

function scheduleSentinelReconnect(
    sentinel,
    reason
) {
    if (sentinel.reconnectTimer) {
        return;
    }

    sentinel.reconnectTimer =
        setTimeout(
            async () => {
                sentinel.reconnectTimer = null;

                await campSentinel(
                    sentinel,
                    reason
                );
            },
            1000
        );
}

async function reconcileSentinel(
    sentinel
) {
    if (!sentinel.client?.user) {
        return;
    }

    if (
        !sentinel.guild ||
        !sentinel.channel
    ) {
        const resolved =
            await resolveTarget(
                sentinel
            );

        if (!resolved) {
            return;
        }
    }

    let actualChannelId =
        null;

    const voiceState =
        sentinel.guild.voiceStates.cache.get(
            sentinel.client.user.id
        );

    if (voiceState?.channelId) {
        actualChannelId =
            voiceState.channelId;
    } else {
        const member =
            sentinel.guild.members.cache.get(
                sentinel.client.user.id
            ) ||
            await sentinel.guild.members
                .fetch(
                    sentinel.client.user.id
                )
                .catch(() => null);

        actualChannelId =
            member?.voice?.channelId ??
            null;
    }

    const connectionStatus =
        sentinel.connection?.state?.status ??
        null;

    if (
        actualChannelId !== sentinel.channelId ||
        !sentinel.connection ||
        connectionStatus ===
            VoiceConnectionStatus.Destroyed
    ) {
        scheduleSentinelReconnect(
            sentinel,
            actualChannelId !== sentinel.channelId
                ? "target channel enforcement"
                : "connection recovery"
        );
    }
}

async function reconcileAll() {
    if (reconcileInProgress) {
        return;
    }

    reconcileInProgress = true;

    try {
        await Promise.allSettled(
            sentinels.map(
                sentinel =>
                    reconcileSentinel(
                        sentinel
                    )
            )
        );
    } finally {
        reconcileInProgress = false;
    }
}

function evaluateSentinel(
    sentinel,
    now
) {
    if (
        !sentinel.client?.user ||
        !sentinel.connection
    ) {
        return {
            sentinel,
            reportable: false,
            degraded: false,
            reason: "offline",
            status: "offline",
            wsPing: null,
            udpPing: null,
            ping: null,
            duration: null
        };
    }

    const status =
        sentinel.connection.state?.status ??
        "unknown";

    const {
        wsPing,
        udpPing,
        ping
    } = getPingData(sentinel);

    if (
        status ===
        VoiceConnectionStatus.Ready
    ) {
        sentinel.nonReadySince = null;
        sentinel.disconnectedSince = null;
    } else if (
        !sentinel.nonReadySince
    ) {
        sentinel.nonReadySince = now;
    }

    cleanStateFlaps(
        sentinel
    );

    if (ping !== null) {
        sentinel.noPingSince = null;
    } else if (
        !sentinel.noPingSince
    ) {
        sentinel.noPingSince = now;
    }

    const base = {
        sentinel,
        reportable:
            now >= sentinel.graceUntil,
        degraded: false,
        reason: null,
        status,
        wsPing,
        udpPing,
        ping,
        duration: null
    };

    if (
        now < sentinel.graceUntil
    ) {
        return base;
    }

    if (
        status ===
        VoiceConnectionStatus.Destroyed
    ) {
        return {
            ...base,
            degraded: true,
            reason: "destroyed",
            duration:
                sentinel.nonReadySince
                    ? now -
                      sentinel.nonReadySince
                    : null
        };
    }

    if (
        status ===
            VoiceConnectionStatus.Disconnected &&
        sentinel.disconnectedSince &&
        now -
            sentinel.disconnectedSince >=
            DISCONNECTED_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "disconnected",
            duration:
                now -
                sentinel.disconnectedSince
        };
    }

    if (
        status ===
            VoiceConnectionStatus.Connecting &&
        sentinel.nonReadySince &&
        now -
            sentinel.nonReadySince >=
            CONNECTING_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "connecting_stuck",
            duration:
                now -
                sentinel.nonReadySince
        };
    }

    if (
        status ===
            VoiceConnectionStatus.Signalling &&
        sentinel.nonReadySince &&
        now -
            sentinel.nonReadySince >=
            SIGNALLING_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "signalling_stuck",
            duration:
                now -
                sentinel.nonReadySince
        };
    }

    if (
        sentinel.noPingSince &&
        now -
            sentinel.noPingSince >=
            NO_PING_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "no_ping",
            duration:
                now -
                sentinel.noPingSince
        };
    }

    if (
        sentinel.stateFlaps.length >=
        STATE_FLAP_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "state_flapping",
            duration:
                STATE_FLAP_WINDOW
        };
    }

    if (
        ping !== null &&
        ping >=
            CRITICAL_PING_LIMIT
    ) {
        return {
            ...base,
            degraded: true,
            reason: "critical_ping",
            duration: null
        };
    }

    if (
        ping !== null &&
        ping > PING_LIMIT
    ) {
        sentinel.badSamples++;

        if (
            sentinel.badSamples >=
            BAD_SAMPLES_REQUIRED
        ) {
            return {
                ...base,
                degraded: true,
                reason: "high_ping",
                duration: null
            };
        }
    } else if (
        ping !== null
    ) {
        sentinel.badSamples = 0;
    }

    return base;
}

function getReasonName(reason) {
    switch (reason) {
        case "high_ping":
            return "High latency";

        case "critical_ping":
            return "Critical latency";

        case "connecting_stuck":
            return "Connection stuck in connecting";

        case "signalling_stuck":
            return "Connection stuck in signalling";

        case "disconnected":
            return "Voice connection disconnected";

        case "no_ping":
            return "No latency response";

        case "state_flapping":
            return "Unstable voice connection";

        case "destroyed":
            return "Voice connection destroyed";

        case "consensus_degradation":
            return "Multi-sentinel degradation";

        default:
            return reason || "Unknown";
    }
}

function getQuorum(
    reportingCount
) {
    const configured =
        Number(
            MONITORING.switchQuorum
        ) || 0;

    if (configured > 0) {
        return Math.min(
            configured,
            Math.max(
                reportingCount,
                1
            )
        );
    }

    return (
        Math.floor(
            reportingCount / 2
        ) + 1
    );
}

function isCriticalReason(
    reason
) {
    return (
        reason === "critical_ping" ||
        reason === "disconnected" ||
        reason === "destroyed" ||
        reason === "connecting_stuck" ||
        reason === "signalling_stuck"
    );
}

function getNextRegion(
    target
) {
    return (
        target.activeRegion === REGIONS[0]
            ? REGIONS[1]
            : REGIONS[0]
    );
}

async function setRtcRegion(
    target,
    targetSentinels,
    newRegion
) {
    for (const sentinel of targetSentinels) {
        if (!sentinel.client?.user) {
            continue;
        }

        try {
            if (!sentinel.channel) {
                const resolved =
                    await resolveTarget(
                        sentinel
                    );

                if (!resolved) {
                    continue;
                }
            }

            await sentinel.channel.setRTCRegion(
                newRegion
            );

            return {
                success: true,
                controller:
                    sentinel.name
            };

        } catch (err) {
            console.log(
                `[${sentinel.name}] RTC region change failed: ${err.message}`
            );
        }
    }

    return {
        success: false,
        controller: null
    };
}

async function getLogsWebhook() {
    if (logsWebhook) {
        return logsWebhook;
    }

    for (const sentinel of sentinels) {
        if (!sentinel.client?.user) {
            continue;
        }

        try {
            const logsGuild =
                sentinel.client.guilds.cache.get(
                    LOGS_GUILD_ID
                ) ||
                await sentinel.client.guilds
                    .fetch(
                        LOGS_GUILD_ID
                    )
                    .catch(
                        () => null
                    );

            if (!logsGuild) {
                continue;
            }

            const logsChannel =
                logsGuild.channels.cache.get(
                    LOGS_CHANNEL_ID
                ) ||
                await logsGuild.channels
                    .fetch(
                        LOGS_CHANNEL_ID
                    )
                    .catch(
                        () => null
                    );

            if (!logsChannel) {
                continue;
            }

            const webhooks =
                await logsChannel.fetchWebhooks();

            let webhook =
                webhooks.find(
                    hook =>
                        hook.name ===
                        "7Seven Voice Sentinel"
                );

            if (!webhook) {
                webhook =
                    await logsChannel.createWebhook(
                        "7Seven Voice Sentinel",
                        {
                            avatar:
                                sentinel.client.user.displayAvatarURL({
                                    dynamic: true
                                })
                        }
                    );
            }

            logsWebhook =
                webhook;

            return webhook;

        } catch {}
    }

    return null;
}

function buildSnapshot(
    evaluations
) {
    const lines =
        evaluations.map(
            item => {
                const latency =
                    item.ping !== null
                        ? `${item.ping}ms`
                        : "N/A";

                const health =
                    item.degraded
                        ? getReasonName(
                            item.reason
                        )
                        : item.reportable
                            ? "Healthy"
                            : "Grace";

                return (
                    `${item.sentinel.name}: ` +
                    `${health} | ` +
                    `${item.status} | ` +
                    `${latency}`
                );
            }
        );

    const text =
        lines.join("\n");

    return (
        text.length > 1000
            ? `${text.slice(0, 997)}...`
            : text
    );
}

async function sendProtectionLog({
    target,
    targetSentinels,
    oldRegion,
    newRegion,
    controller,
    evaluations,
    degraded,
    quorum
}) {
    try {
        const webhook =
            await getLogsWebhook();

        if (!webhook) {
            console.log(
                "Logs webhook unavailable"
            );

            return;
        }

        const mainReason =
            degraded.length === 1
                ? degraded[0].reason
                : "consensus_degradation";

        const detection =
            degraded
                .map(
                    item =>
                        `${item.sentinel.name}: ` +
                        `${getReasonName(item.reason)}`
                )
                .join("\n");

        const embed =
            new MessageEmbed()
                .setColor("#000000")
                .setTitle(
                    "Layer 4 DDOS attack detected"
                )
                .setDescription(
                    "The sentinel group detected a voice degradation quorum. RTC failover was activated automatically."
                )
                .addFields(
                    {
                        name: "Detection",
                        value:
                            `\`${getReasonName(mainReason)}\``,
                        inline: false
                    },
                    {
                        name: "Target guild",
                        value:
                            `\`${target.guildId}\``,
                        inline: true
                    },
                    {
                        name: "Target channel",
                        value:
                            `<#${target.channelId}>`,
                        inline: true
                    },
                    {
                        name: "Previous region",
                        value:
                            `\`${oldRegion}\``,
                        inline: true
                    },
                    {
                        name: "New region",
                        value:
                            `\`${newRegion}\``,
                        inline: true
                    },
                    {
                        name: "Consensus",
                        value:
                            `\`${degraded.length}/${evaluations.filter(x => x.reportable).length}\` degraded\n` +
                            `Quorum: \`${quorum}\``,
                        inline: true
                    },
                    {
                        name: "Sentinels",
                        value:
                            `\`${targetSentinels.length}\``,
                        inline: true
                    },
                    {
                        name: "Controller",
                        value:
                            `\`${controller ?? "unknown"}\``,
                        inline: true
                    },
                    {
                        name: "Triggered by",
                        value:
                            detection.length > 1000
                                ? `${detection.slice(0, 997)}...`
                                : detection,
                        inline: false
                    },
                    {
                        name: "Sentinel snapshot",
                        value:
                            buildSnapshot(
                                evaluations
                            ),
                        inline: false
                    }
                )
                .setFooter({
                    text:
                        "Anti DDOS Protection • 7Seven-Corp"
                })
                .setTimestamp();

        await webhook.send({
            username:
                "7Seven Voice Sentinel",

            embeds: [
                embed
            ]
        });

    } catch (err) {
        console.log(
            `Protection log failed: ${err.message}`
        );

        logsWebhook = null;
    }
}

async function switchRegionForTarget(
    target,
    targetSentinels,
    evaluations,
    degraded,
    quorum
) {
    if (
        target.switchInProgress
    ) {
        return false;
    }

    const now =
        Date.now();

    const hasCritical =
        degraded.some(
            item =>
                isCriticalReason(
                    item.reason
                )
        );

    const cooldown =
        hasCritical
            ? CRITICAL_SWITCH_COOLDOWN
            : SWITCH_COOLDOWN;

    if (
        now - target.lastSwitch <
        cooldown
    ) {
        return false;
    }

    target.switchInProgress =
        true;

    const oldRegion =
        target.activeRegion;

    const newRegion =
        getNextRegion(target);

    console.log(
        `[${target.channelId}] Group degradation detected: ` +
        `${degraded.length}/` +
        `${evaluations.filter(x => x.reportable).length}`
    );

    console.log(
        `[${target.channelId}] Switching region: ${oldRegion} -> ${newRegion}`
    );

    try {
        const result =
            await setRtcRegion(
                target,
                targetSentinels,
                newRegion
            );

        if (!result.success) {
            console.log(
                `[${target.channelId}] Region change failed on every sentinel`
            );

            return false;
        }

        target.activeRegion =
            newRegion;

        target.lastSwitch =
            Date.now();

        target.regionInitialized =
            true;

        for (const sentinel of targetSentinels) {
            resetSentinelHealth(
                sentinel
            );

            sentinel.graceUntil =
                Date.now() +
                POST_SWITCH_GRACE;
        }

        console.log(
            `[${target.channelId}] Region changed -> ${newRegion} by ${result.controller}`
        );

        sendProtectionLog({
            target,
            targetSentinels,
            oldRegion,
            newRegion,
            controller:
                result.controller,
            evaluations,
            degraded,
            quorum
        });

        return true;

    } finally {
        target.switchInProgress =
            false;
    }
}

async function rebuildDegradedSentinels(
    degraded
) {
    for (const item of degraded) {
        const sentinel =
            item.sentinel;

        if (
            Date.now() -
                sentinel.lastReconnect <
            SENTINEL_RECONNECT_COOLDOWN
        ) {
            continue;
        }

        console.log(
            `[${sentinel.name}] Local degradation detected: ${item.reason}`
        );

        scheduleSentinelReconnect(
            sentinel,
            `local recovery: ${item.reason}`
        );
    }
}

function getSentinelsForTarget(
    targetKey
) {
    return sentinels.filter(
        sentinel =>
            sentinel.targetKey ===
            targetKey
    );
}

async function monitorTarget(
    target,
    now
) {
    const targetSentinels =
        getSentinelsForTarget(
            target.key
        );

    const evaluations =
        targetSentinels.map(
            sentinel =>
                evaluateSentinel(
                    sentinel,
                    now
                )
        );

    for (const item of evaluations) {
        console.log(
            `[${item.sentinel.name}] ` +
            `Target: ${item.sentinel.guildId}/${item.sentinel.channelId} | ` +
            `State: ${item.status} | ` +
            `Region: ${target.activeRegion} | ` +
            `WS: ${item.wsPing ?? "N/A"} ms | ` +
            `UDP: ${item.udpPing ?? "N/A"} ms` + "\n"
        );
    }

    const reporting =
        evaluations.filter(
            item => item.reportable
        );

    if (
        reporting.length === 0
    ) {
        return;
    }

    const degraded =
        reporting.filter(
            item => item.degraded
        );

    if (
        degraded.length === 0
    ) {
        return;
    }

    const quorum =
        getQuorum(
            reporting.length
        );

    if (
        degraded.length >= quorum
    ) {
        await switchRegionForTarget(
            target,
            targetSentinels,
            evaluations,
            degraded,
            quorum
        );

        return;
    }

    await rebuildDegradedSentinels(
        degraded
    );
}

async function monitorAllTargets() {
    const now =
        Date.now();

    if (
        now - lastReconcile >=
        RECONCILE_INTERVAL
    ) {
        lastReconcile =
            now;

        await reconcileAll();
    }

    for (const target of targets.values()) {
        await monitorTarget(
            target,
            now
        );
    }
}

function startMonitor() {
    if (monitor) {
        return;
    }

    monitor =
        setInterval(
            () => {
                monitorAllTargets()
                    .catch(
                        err => {
                            console.log(
                                `Monitor error: ${err.message}`
                            );
                        }
                    );
            },
            CHECK_INTERVAL
        );
}

function createSentinelClient(
    sentinel
) {
    const client =
        new Client({
            checkUpdate: false
        });

    sentinel.client =
        client;

    client.once(
        "ready",
        async () => {
            sentinel.ready =
                true;

            console.log(
                `[${sentinel.name}] Online: ${client.user.tag}`
            );

            console.log(
                `[${sentinel.name}] Target: ${sentinel.guildId}/${sentinel.channelId}`
            );

            const connected =
                await campSentinel(
                    sentinel,
                    "startup"
                );

            if (!connected) {
                scheduleSentinelReconnect(
                    sentinel,
                    "startup retry"
                );
            }
        }
    );

    client.on(
        "voiceStateUpdate",
        (oldState, newState) => {
            if (
                !client.user ||
                newState.id !==
                    client.user.id
            ) {
                return;
            }

            if (
                newState.guild.id !==
                sentinel.guildId
            ) {
                return;
            }

            if (
                newState.channelId !==
                sentinel.channelId
            ) {
                console.log(
                    `[${sentinel.name}] Left target channel, restoring sentinel`
                );

                scheduleSentinelReconnect(
                    sentinel,
                    "target channel enforcement"
                );
            }
        }
    );

    client.on(
        "error",
        err => {
            console.log(
                `[${sentinel.name}] Client error: ${err.message}`
            );
        }
    );

    return client;
}

async function loginSentinels() {
    printBanner();

    console.log(
        `Starting ${sentinels.length} sentinel(s) across ${targets.size} target(s)`
    );

    console.log(
        `Logs target: ${LOGS_GUILD_ID}/${LOGS_CHANNEL_ID}`
    );

    for (const sentinel of sentinels) {
        const client =
            createSentinelClient(
                sentinel
            );

        client.login(
            sentinel.token
        ).catch(
            err => {
                console.log(
                    `[${sentinel.name}] Login failed: ${err.message}`
                );
            }
        );

        await sleep(
            LOGIN_STAGGER
        );
    }

    startMonitor();
}

async function shutdown() {
    console.log(
        "Stopping sentinels"
    );

    if (monitor) {
        clearInterval(
            monitor
        );

        monitor = null;
    }

    for (const sentinel of sentinels) {
        if (
            sentinel.reconnectTimer
        ) {
            clearTimeout(
                sentinel.reconnectTimer
            );

            sentinel.reconnectTimer =
                null;
        }

        destroySentinelConnection(
            sentinel
        );

        try {
            sentinel.client?.destroy();
        } catch {}
    }
}

process.on(
    "unhandledRejection",
    error => {
        console.log(
            "Unhandled rejection:",
            error
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.log(
            "Uncaught exception:",
            error
        );
    }
);

process.on(
    "SIGINT",
    async () => {
        await shutdown();
        process.exit(0);
    }
);

process.on(
    "SIGTERM",
    async () => {
        await shutdown();
        process.exit(0);
    }
);

loginSentinels();
