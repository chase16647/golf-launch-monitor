//
//  FrameRingBuffer.swift
//  GolfLaunchMonitor
//
//  Lock-free single-producer / single-consumer ring of CVPixelBuffers.
//
//  Design constraints:
//   * The producer is AVFoundation's capture callback queue. At 240 FPS it gets
//     4.16 ms per frame. Anything that allocates, locks, or touches Swift's
//     runtime metadata in that path risks a dropped frame, so this type does
//     none of those things in `write(_:)`.
//   * Storage is a fixed `UnsafeMutableBufferPointer` of `Unmanaged<CVBuffer>?`
//     allocated once at init. No ARC traffic on the hot path: we retain the
//     pixel buffer exactly once with `passRetained` and release the slot's
//     previous occupant manually.
//   * Sequencing uses `Synchronization.Atomic` (iOS 18+ / Swift 6) with explicit
//     acquire/release ordering rather than a lock. Correct for exactly one
//     producer thread and one consumer thread, which is what we have.
//
//  IMPORTANT: capacity must be <= the capture pool's buffer count, otherwise
//  holding 30 frames starves AVFoundation and it starts dropping. See
//  `CameraManager.configurePixelBufferPool` for how that is negotiated.
//

import Foundation
import CoreVideo
import CoreMedia
import Synchronization

/// One captured frame plus the metadata the analyzer needs to interpret it.
/// Deliberately a value type of POD fields so it can live in a preallocated array.
/// `@unchecked Sendable` because CVPixelBuffer is not annotated Sendable, yet
/// moving one of these between the capture queue and the analyzer actor is
/// safe here by construction:
///
///   * The ring holds a strong retain on every buffer it hands out, so the
///     capture pool cannot recycle a buffer while the analyzer holds it.
///   * The analyzer only ever READS pixel data. Nothing mutates a buffer after
///     AVFoundation has delivered it.
///   * `snapshot` re-checks the write head after copying and refuses to return
///     a range that was overwritten mid-copy.
///
/// Without this, every hand-off to BallTracker is "sending risks causing data
/// races" — a true statement about the type, not about this usage.
struct FrameSlot: @unchecked Sendable {
    var pixelBuffer: CVPixelBuffer
    /// Presentation timestamp straight from the sample buffer. This is the
    /// authoritative clock — do *not* assume 1/240 s spacing, the sensor drops
    /// frames under thermal load and the deltas matter for velocity.
    var presentationTime: CMTime
    /// Monotonic index assigned by the producer. Gaps mean dropped frames.
    var sequence: Int
}

/// SPSC lock-free ring. Producer calls `write`, consumer calls `snapshot`.
final class FrameRingBuffer: @unchecked Sendable {

    /// Number of frames retained. 30 frames @ 240 FPS = 125 ms of history,
    /// which comfortably brackets impact (we need ~8 pre-impact frames to
    /// establish the ball is stationary and 12 after).
    let capacity: Int

    private let storage: UnsafeMutableBufferPointer<Unmanaged<CVPixelBuffer>?>
    private let times: UnsafeMutableBufferPointer<CMTime>

    /// Total frames ever written. `writeIndex % capacity` is the next slot.
    /// Released by the producer after the slot contents are visible; acquired
    /// by the consumer before it reads any slot.
    private let writeIndex = Atomic<Int>(0)

    init(capacity: Int = 30) {
        precondition(capacity > 0)
        self.capacity = capacity
        storage = .allocate(capacity: capacity)
        storage.initialize(repeating: nil)
        times = .allocate(capacity: capacity)
        times.initialize(repeating: .invalid)
    }

    deinit {
        for i in 0..<capacity { storage[i]?.release() }
        storage.deallocate()
        times.deallocate()
    }

    // MARK: - Producer

    /// Called from the AVFoundation capture queue. Must not allocate or block.
    /// Returns the sequence number assigned to this frame.
    @discardableResult
    func write(_ pixelBuffer: CVPixelBuffer, pts: CMTime) -> Int {
        // Relaxed load is fine: we are the only writer, so no one else can
        // have advanced this since our last store.
        let seq = writeIndex.load(ordering: .relaxed)
        let slot = seq % capacity

        // Hand ownership of the previous occupant back. The consumer is only
        // ever allowed to look at frames within `capacity` of the write head,
        // so by the time we recycle a slot the consumer has been warned off it
        // via the sequence check in `snapshot`.
        storage[slot]?.release()
        storage[slot] = Unmanaged.passRetained(pixelBuffer)
        times[slot] = pts

        // Release: everything above must be visible to a consumer that
        // acquires this value.
        writeIndex.store(seq + 1, ordering: .releasing)
        return seq
    }

    // MARK: - Consumer

    /// Most recent sequence number written.
    var latestSequence: Int { writeIndex.load(ordering: .acquiring) }

    /// Copy out a contiguous run of frames ending at `endSequence` (inclusive).
    ///
    /// Returns `nil` if the requested range has already been overwritten —
    /// the caller must then accept that it was too slow. We never hand back a
    /// torn frame.
    ///
    /// This *does* allocate (it builds an array) and is only ever called once
    /// per shot, off the capture queue, after streaming has already stopped.
    func snapshot(endingAt endSequence: Int, count: Int) -> [FrameSlot]? {
        guard count > 0, count <= capacity else { return nil }
        let start = endSequence - count + 1
        guard start >= 0 else { return nil }

        let head = writeIndex.load(ordering: .acquiring)
        // The oldest sequence still intact. Anything below this has been
        // recycled under us.
        guard start >= head - capacity, endSequence < head else { return nil }

        var out = [FrameSlot]()
        out.reserveCapacity(count)
        for seq in start...endSequence {
            let slot = seq % capacity
            guard let unmanaged = storage[slot] else { return nil }
            out.append(FrameSlot(pixelBuffer: unmanaged.takeUnretainedValue(),
                                 presentationTime: times[slot],
                                 sequence: seq))
        }

        // Re-check: if the head moved far enough during the copy to have
        // clobbered our start, discard rather than return mixed frames.
        let headAfter = writeIndex.load(ordering: .acquiring)
        guard start >= headAfter - capacity else { return nil }

        // Retain for the consumer's lifetime: the returned FrameSlots hold
        // strong CVPixelBuffer references via ARC on the struct field, so
        // they stay alive even once the producer recycles the slot.
        return out
    }

    /// Drop every retained frame. Called when disarming so we don't pin
    /// capture-pool buffers while idle.
    func reset() {
        for i in 0..<capacity {
            storage[i]?.release()
            storage[i] = nil
            times[i] = .invalid
        }
        writeIndex.store(0, ordering: .releasing)
    }
}
