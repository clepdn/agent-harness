import assert from "node:assert/strict"
import test from "node:test"
import { OPUS_FRAME_SAMPLES, OPUS_PAYLOAD_TYPE, OpusRtpPacketizer } from "./voice-rtp"

test("OpusRtpPacketizer wraps Discord Opus frames with monotonic WebRTC RTP headers", () => {
  const packetizer = new OpusRtpPacketizer({ sequenceNumber: 0xffff, timestamp: 0xffff_ff00, ssrc: 42 })
  const first = packetizer.packetize(Buffer.from([1, 2, 3]))
  const second = packetizer.packetize(Buffer.from([4, 5]))

  assert.equal(first.header.payloadType, OPUS_PAYLOAD_TYPE)
  assert.equal(first.header.sequenceNumber, 0xffff)
  assert.equal(first.header.timestamp, 0xffff_ff00)
  assert.equal(first.header.ssrc, 42)
  assert.deepEqual(first.payload, Buffer.from([1, 2, 3]))
  assert.equal(second.header.sequenceNumber, 0)
  assert.equal(second.header.timestamp, (0xffff_ff00 + OPUS_FRAME_SAMPLES) >>> 0)
  assert.equal(second.header.ssrc, 42)
})
