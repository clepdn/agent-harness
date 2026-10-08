import { randomBytes } from "node:crypto"
import { RtpHeader, RtpPacket } from "werift"

export const OPUS_CLOCK_RATE = 48_000
export const OPUS_PAYLOAD_TYPE = 111
export const OPUS_FRAME_SAMPLES = 960 // Discord voice packets are normally 20 ms at 48 kHz.

function randomUint16(): number {
  return randomBytes(2).readUInt16BE(0)
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0)
}

/** Adds the RTP envelope required by WebRTC to Discord's bare Opus packets. */
export class OpusRtpPacketizer {
  private sequenceNumber: number
  private timestamp: number
  private readonly ssrc: number

  constructor(initial?: { sequenceNumber?: number; timestamp?: number; ssrc?: number }) {
    this.sequenceNumber = initial?.sequenceNumber ?? randomUint16()
    this.timestamp = initial?.timestamp ?? randomUint32()
    this.ssrc = initial?.ssrc ?? randomUint32()
  }

  packetize(opus: Buffer): RtpPacket {
    const packet = new RtpPacket(
      new RtpHeader({
        payloadType: OPUS_PAYLOAD_TYPE,
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
      }),
      Buffer.from(opus),
    )
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff
    this.timestamp = (this.timestamp + OPUS_FRAME_SAMPLES) >>> 0
    return packet
  }
}
