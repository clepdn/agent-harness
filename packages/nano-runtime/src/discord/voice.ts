import fs from "node:fs/promises"
import path from "node:path"
import { PassThrough } from "node:stream"
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice"
import type { GuildMember, VoiceBasedChannel } from "discord.js"
import { MediaStreamTrack, RTCPeerConnection, useOPUS, type RTCDataChannel } from "werift"
import { NANO_HOME } from "../agent-config"
import { config } from "../config"
import { OpusRtpPacketizer } from "./voice-rtp"

const CONNECT_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_OUTPUT_PACKETS = 100
const SOUL_PATH = path.join(NANO_HOME, "soul.md")

export type VoiceSessionStatus = {
  active: boolean
  channelId?: string
  channelName?: string
  guildId?: string
  model?: string
}

type ActiveVoiceSession = {
  channel: VoiceBasedChannel
  connection: VoiceConnection
  player: AudioPlayer
  peer: RTCPeerConnection
  events: RTCDataChannel
  inputTrack: MediaStreamTrack
  ownerAudio: AudioReceiveStream
  output: PassThrough
  stopOutput: () => void
  closing: boolean
  stop: () => Promise<void>
}

type PendingStartup = {
  controller: AbortController
}

let activeSession: ActiveVoiceSession | null = null
let pendingStartup: PendingStartup | null = null
let transition: Promise<void> = Promise.resolve()

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = transition.then(operation, operation)
  transition = result.then(() => undefined, () => undefined)
  return result
}

export function realtimeCallsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!normalized) throw new Error("llm_bridge_url is not configured")
  return normalized.endsWith("/v1")
    ? `${normalized}/realtime/calls`
    : `${normalized}/v1/realtime/calls`
}

export function realtimeCallBody(sdp: string, model: string, instructions: string, voice: string): Record<string, unknown> {
  return {
    sdp,
    session: {
      model,
      instructions,
      audio: { output: { voice } },
      delegation: { type: "client" },
    },
  }
}

export function realtimeCallRequest(
  baseUrl: string,
  apiKey: string,
  sdp: string,
  model: string,
  instructions: string,
  voice: string,
): { url: string; init: RequestInit } {
  return {
    url: realtimeCallsUrl(baseUrl),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/sdp",
      },
      body: JSON.stringify(realtimeCallBody(sdp, model, instructions, voice)),
    },
  }
}

async function voiceInstructions(): Promise<string> {
  const soul = await fs.readFile(SOUL_PATH, "utf8").catch(() => "")
  return [
    soul.trim(),
    "You are speaking live in a Discord voice channel with your owner.",
    "Respond naturally and conversationally. Keep turns brief unless asked for detail.",
    "This realtime voice session has no tools and no access to the text conversation. Never claim to have used tools.",
  ].filter(Boolean).join("\n\n---\n\n")
}

async function createRealtimePeer(onOutputPacket: (packet: Buffer) => void, signal: AbortSignal): Promise<{
  peer: RTCPeerConnection
  events: RTCDataChannel
  inputTrack: MediaStreamTrack
  stopOutput: () => void
}> {
  const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })] } })
  const inputTrack = new MediaStreamTrack({ kind: "audio" })
  peer.addTransceiver(inputTrack, { direction: "sendrecv" })
  const events = peer.createDataChannel("oai-events")
  const outputSubscriptions: Array<() => void> = []
  const trackSubscription = peer.onTrack.subscribe((track) => {
    if (track.kind !== "audio") return
    const subscription = track.onReceiveRtp.subscribe((packet) => onOutputPacket(Buffer.from(packet.payload)))
    outputSubscriptions.push(subscription.unSubscribe)
  })
  const stopOutput = (): void => {
    trackSubscription.unSubscribe()
    for (const unsubscribe of outputSubscriptions.splice(0)) unsubscribe()
  }

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const local = peer.localDescription
    if (!local?.sdp) throw new Error("WebRTC offer did not produce SDP")

    const request = realtimeCallRequest(
      config.llm_bridge_url,
      config.llm_bridge_api_key,
      local.sdp,
      config.discord.voice_model,
      await voiceInstructions(),
      config.discord.voice,
    )
    const response = await fetch(request.url, {
      ...request.init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    })
    const answer = await response.text()
    if (!response.ok) {
      const detail = answer.trim().slice(0, 500)
      throw new Error(`realtime call failed (${response.status})${detail ? `: ${detail}` : ""}`)
    }
    if (!answer.trim()) throw new Error("realtime call returned empty SDP")
    await peer.setRemoteDescription({ type: "answer", sdp: answer })
    return { peer, events, inputTrack, stopOutput }
  } catch (error) {
    stopOutput()
    events.close()
    inputTrack.stop()
    await peer.close().catch(() => {})
    throw error
  }
}

async function closeSession(session: ActiveVoiceSession): Promise<void> {
  if (session.closing) return
  session.closing = true
  if (activeSession === session) activeSession = null
  session.stopOutput()
  session.ownerAudio.destroy()
  session.player.stop(true)
  session.events.close()
  session.inputTrack.stop()
  session.connection.destroy()
  if (!session.output.destroyed) session.output.destroy()
  await session.peer.close().catch(() => {})
}

function closeFailedSession(session: ActiveVoiceSession, reason: string): void {
  if (session.closing) return
  console.warn(`[discord voice] ${reason}`)
  void closeSession(session).catch((error) => {
    console.warn("[discord voice] teardown failed:", error instanceof Error ? error.message : String(error))
  })
}

async function connectVoice(owner: GuildMember, channel: VoiceBasedChannel, signal: AbortSignal): Promise<ActiveVoiceSession> {
  if (!config.discord.voice_enabled) throw new Error("Discord realtime voice is disabled")
  if (!config.discord.owner_id) throw new Error("[discord].owner_id is not configured")
  if (!config.llm_bridge_api_key) throw new Error("llm_bridge_api_key is not configured")
  if (!channel.guild.voiceAdapterCreator) throw new Error("Discord voice adapter is unavailable")

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  })

  let peer: RTCPeerConnection | null = null
  let events: RTCDataChannel | null = null
  let inputTrack: MediaStreamTrack | null = null
  let ownerAudio: AudioReceiveStream | null = null
  let output: PassThrough | null = null
  let stopOutput = (): void => {}

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, AbortSignal.any([
      signal,
      AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    ]))
    output = new PassThrough({ objectMode: true, highWaterMark: MAX_OUTPUT_PACKETS })
    ;({ peer, events, inputTrack, stopOutput } = await createRealtimePeer((packet) => {
      // Discord consumes one Opus packet every 20ms. Drop newest packets if its
      // player falls two seconds behind rather than growing latency without bound.
      if (!output!.destroyed && !output!.writableEnded && output!.writableLength < MAX_OUTPUT_PACKETS) {
        output!.write(packet)
      }
    }, signal))

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
    connection.subscribe(player)
    player.play(createAudioResource(output, { inputType: StreamType.Opus, silencePaddingFrames: 1 }))

    const packetizer = new OpusRtpPacketizer()
    ownerAudio = connection.receiver.subscribe(owner.id, {
      end: { behavior: EndBehaviorType.Manual },
    })
    ownerAudio.on("data", (packet: Buffer) => {
      if (!inputTrack!.stopped) inputTrack!.writeRtp(packetizer.packetize(packet))
    })

    const session: ActiveVoiceSession = {
      channel,
      connection,
      player,
      peer,
      events,
      inputTrack,
      ownerAudio,
      output,
      stopOutput,
      closing: false,
      stop: async (): Promise<void> => closeSession(session),
    }

    output.on("error", (error) => closeFailedSession(session, `output stream error: ${error.message}`))
    player.on("error", (error) => closeFailedSession(session, `playback error: ${error.message}`))
    ownerAudio.on("error", (error) => closeFailedSession(session, `receive error: ${error.message}`))
    connection.on(VoiceConnectionStatus.Disconnected, () => closeFailedSession(session, "Discord voice disconnected"))
    connection.on(VoiceConnectionStatus.Destroyed, () => closeFailedSession(session, "Discord voice connection destroyed"))
    peer.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") closeFailedSession(session, `realtime peer ${state}`)
    })
    events.error.subscribe((error) => closeFailedSession(session, `realtime events error: ${error.message}`))
    events.onMessage.subscribe((raw) => {
      try {
        const event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as { type?: string; error?: { message?: string } }
        if (event.type === "error") {
          closeFailedSession(session, `realtime protocol error: ${event.error?.message ?? "unknown error"}`)
        }
      } catch {
        // The media relay does not consume normal realtime events.
      }
    })

    if (signal.aborted || session.closing) {
      await closeSession(session)
      throw signal.reason instanceof Error ? signal.reason : new Error("voice startup cancelled")
    }
    return session
  } catch (error) {
    stopOutput()
    ownerAudio?.destroy()
    output?.destroy()
    events?.close()
    inputTrack?.stop()
    connection.destroy()
    if (peer) await peer.close().catch(() => {})
    throw error
  }
}

export async function joinOwnerVoice(owner: GuildMember): Promise<VoiceSessionStatus> {
  pendingStartup?.controller.abort(new Error("voice startup superseded"))
  const startup: PendingStartup = { controller: new AbortController() }
  pendingStartup = startup

  return serialized(async () => {
    try {
      const channel = owner.voice.channel
      if (!channel) throw new Error("join a voice channel first")
      if (activeSession?.channel.id === channel.id) return getVoiceSessionStatus()
      if (startup.controller.signal.aborted) throw startup.controller.signal.reason
      if (activeSession) await activeSession.stop()
      const session = await connectVoice(owner, channel, startup.controller.signal)
      if (startup.controller.signal.aborted || session.closing) {
        await session.stop()
        throw startup.controller.signal.reason ?? new Error("voice startup cancelled")
      }
      activeSession = session
      console.log(`[discord voice] joined guild=${channel.guild.id} channel=${channel.id} model=${config.discord.voice_model}`)
      return getVoiceSessionStatus()
    } finally {
      if (pendingStartup === startup) pendingStartup = null
    }
  })
}

export async function leaveVoice(): Promise<boolean> {
  const cancelledStartup = pendingStartup !== null
  pendingStartup?.controller.abort(new Error("voice startup cancelled"))
  return serialized(async () => {
    const session = activeSession
    if (!session) return cancelledStartup
    await session.stop()
    console.log("[discord voice] left")
    return true
  })
}

export async function stopDiscordVoice(): Promise<void> {
  await leaveVoice()
}

export function getVoiceSessionStatus(): VoiceSessionStatus {
  const session = activeSession
  return session && !session.closing
    ? {
        active: true,
        channelId: session.channel.id,
        channelName: session.channel.name,
        guildId: session.channel.guild.id,
        model: config.discord.voice_model,
      }
    : { active: false }
}
